#!/usr/bin/env node
// -*- mode: js; indent-tabs-mode: nil; js-basic-offset: 4 -*-
//
// This file is part of ThingEngine
//
// Copyright 2018 The Board of Trustees of the Leland Stanford Junior University
//
// Author: Giovanni Campagna <gcampagn@cs.stanford.edu>
//
// See COPYING for details
"use strict";

// load thingpedia to initialize the polyfill
require('thingpedia');

process.on('unhandledRejection', (up) => { throw up; });
require('../util/config_init');

const Stream = require('stream');
const seedrandom = require('seedrandom');
const argparse = require('argparse');
const path = require('path');

const ThingTalk = require('thingtalk');
const Genie = require('genie-toolkit');

const exampleModel = require('../model/example');

const AdminThingpediaClient = require('../util/admin-thingpedia-client');
const { makeFlags } = require('./flag_utils');
const StreamUtils = require('./stream-utils');

const db = require('../util/db');

// FIXME
const GENIE_FILE = path.resolve(path.dirname(module.filename), '../node_modules/genie-toolkit/languages/en/thingtalk.genie');


class ForDevicesFilter extends Stream.Transform {
    constructor(pattern) {
        super({
            readableObjectMode: true,
            writableObjectMode: true,
        });

        this._pattern = pattern;
    }

    _transform(ex, encoding, callback) {
        if (this._pattern.test(ex.target_code))
            this.push(ex);
        callback();
    }

    _flush(callback) {
        process.nextTick(callback);
    }
}

class DatabaseInserter extends Stream.Writable {
    constructor(language, dbClient) {
        super({
            objectMode: true,
            highWaterMark: 1000,
        });

        this._language = language;
        this._dbClient = dbClient;
        this._batch = [];
    }

    async _insertBatch(examples) {
        return exampleModel.createMany(this._dbClient, examples.map((ex) => {
            return {
                utterance: ex.preprocessed,
                preprocessed: ex.preprocessed,
                target_code: ex.target_code,
                target_json: '',
                type: ex.type,
                flags: makeFlags(ex.flags),
                is_base: 0,
                language: this._language
            };
        }));
    }

    async _process(ex) {
        this._batch.push(ex);
        if (this._batch.length >= 1000) {
            await this._insertBatch(this._batch, false);
            this._batch.length = 0;
        }
    }

    _write(ex, encoding, callback) {
        this._process(ex).then(() => callback(), (err) => callback(err));
    }

    _final(callback) {
        this._insertBatch(this._batch).then(() => callback(), (err) => callback(err));
    }
}

class DatasetUpdater {
    constructor(language, forDevices, options) {
        this._language = language;
        this._options = options;
        this._rng = seedrandom.alea('almond is awesome');

        this._forDevices = forDevices;
        if (forDevices !== null && forDevices.length > 0) {
            const escapedDevices = forDevices.map((d) => d.replace(/[.\\]/g, '\\$&')).join('|');
            const pat1 = ' @(' + escapedDevices + ')\\.[A-Za-z0-9_]+( |$)';
            const pat2 = ' device:(' + escapedDevices + ')( |$)';

            this._forDevicesPattern = '(' + pat1 + '|' + pat2 + ')';
            console.log(this._forDevicesPattern);
            this._forDevicesRegexp = new RegExp(this._forDevicesPattern);
        } else {
            this._forDevicesPattern = null;
            this._forDevicesRegexp = null;
        }

        this._dbClient = null;
        this._tpClient = null;
        this._schemas = null;
        this._augmenter = null;
    }

    async _clearExistingDataset() {
        if (this._forDevicesPattern !== null) {
            await db.query(this._dbClient, `delete from example_utterances where language = ? and type = 'generated'
                and target_code rlike ?`, [this._language, this._forDevicesPattern]);
        } else {
            await db.query(this._dbClient, `delete from example_utterances where language = ? and type = 'generated'`, [this._language]);
        }

        console.log(`Dataset cleaned`);
    }

    async _typecheckParaphrasesAndOnline() {
        let rows;
        if (this._forDevicesPattern !== null) {
            rows = await db.selectAll(this._dbClient, `select id,preprocessed,target_code from example_utterances
                where type not in ('generated', 'thingpedia') and find_in_set('training', flags)
                and not find_in_set('obsolete', flags) and language = ? and target_code rlike ?`,
                [this._language, this._forDevicesPattern]);
        } else {
            rows = await db.selectAll(this._dbClient, `select id,preprocessed,target_code from example_utterances
                where type not in ('generated', 'thingpedia') and find_in_set('training', flags)
                and not find_in_set('obsolete', flags) and language = ?`,
                [this._language]);
        }

        for (let i = 0; i < rows.length+1000-1; i += 1000) {
            const batch = rows.slice(i, i+1000);

            const toUpdate = (await Promise.all(batch.map(async (ex) => {
                const entities = Genie.Utils.makeDummyEntities(ex.preprocessed);
                const program = ThingTalk.NNSyntax.fromNN(ex.target_code.split(' '), entities);

                try {
                    await program.typecheck(this._schemas);
                    this.push(ex);
                    return;
                } catch(e) {
                    this._dropped++;
                }
            }))).filter((id) => id !== null);

            if (toUpdate.length > 0) {
                await db.query(this._dbClient, `update example_utterances set
                    flags = concat(flags, ',obsolete') where id in (?)`, [toUpdate]);
            }
        }
    }

    async _generateNewSynthetic() {
        const options = {
            thingpediaClient: this._tpClient,
            schemaRetriever: this._schemas,

            templateFile: GENIE_FILE,

            rng: this._rng,
            locale: this._language,
            flags: {
                turking: false,
                policies: true,
                remote_programs: true,
                aggregation: true,
                bookkeeping: true,
                triple_commands: true,
                configure_actions: true,
                timer: true,
                projection: true,
                undefined_filter: true,
                projection_with_filter: false,
                extended_timers: false
            },
            maxDepth: this._options.maxDepth,
            debug: this._options.debug,
        };

        let generator = new Genie.BasicSentenceGenerator(options);
        if (this._forDevicesRegexp !== null)
            generator = generator.pipe(new ForDevicesFilter(this._forDevicesRegexp));

        const transform = new Stream.Transform({
            readableObjectMode: true,
            writableObjectMode: true,

            transform(ex, encoding, callback) {
                ex.type = 'generated';
                // do not set the training flag, we will regenerate the synthetic portion of the dataset
                // for training later
                ex.flags.exact = true;
                callback(null, ex);
            },

            flush(callback) {
                process.nextTick(callback);
            }
        });
        const writer = generator
            .pipe(transform)
            .pipe(new DatabaseInserter(this._language, this._dbClient));

        await StreamUtils.waitFinish(writer);
    }

    async _transaction() {
        this._tpClient = new AdminThingpediaClient(this._language, this._dbClient);
        this._schemas = new ThingTalk.SchemaRetriever(this._tpClient, null, !this._options.debug);

        await this._clearExistingDataset();
        await this._typecheckParaphrasesAndOnline();
        await this._generateNewSynthetic();
    }

    async run() {
        await db.withTransaction((dbClient) => {
            this._dbClient = dbClient;
            return this._transaction();
        }, 'repeatable read');
    }
}


async function main() {
    const parser = new argparse.ArgumentParser({
        addHelp: true,
        description: 'Update stored Thingpedia dataset'
    });
    parser.addArgument(['-l', '--language'], {
        required: true,
    });
    parser.addArgument(['-d', '--device'], {
        action: 'append',
        metavar: 'DEVICE',
        help: 'Restrict update to command of the given device. This option can be passed multiple times to specify multiple devices',
        dest: 'forDevices',
    });
    parser.addArgument('--maxdepth', {
        type: Number,
        defaultValue: 3,
        help: 'Maximum depth of synthetic sentence generation',
    });
    parser.addArgument('--debug', {
        nargs: 0,
        action: 'storeTrue',
        help: 'Enable debugging.',
        defaultValue: false
    });
    parser.addArgument('--no-debug', {
        nargs: 0,
        action: 'storeFalse',
        dest: 'debug',
        help: 'Disable debugging.',
    });
    const args = parser.parseArgs();

    const updater = new DatasetUpdater(args.language, args.forDevices, {
        maxDepth: args.maxdepth,
        debug: args.debug
    });
    await updater.run();

    await db.tearDown();
}
main();

