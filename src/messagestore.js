var commons = require("../../commons/src/commons");
const conf = commons.merge(require('./conf/mex'), require('./conf/mex-' + (process.env.ENVIRONMENT || 'localhost')));
const obj = commons.obj(conf);

const logger = obj.logger();
const db = obj.db();
const security_checks = obj.security_checks();
const Utility = obj.utility();
const buildQuery = obj.query_builder();
const Joi = require('joi');

var servicesEnforcedTags = null;

const req_promise = require('request-promise');
var heapdump = require('heapdump');
var uuid = require('uuid');
var escape = require('escape-html');

var express = require('express');
var bodyParser = require('body-parser');

const crypto = obj.cryptoAES_cbc();

const decrypt = function(text) {
    try {
        if(!text || text ==null) return text;
        return crypto.decrypt(text,conf.security.passphrase)
    } catch(e) {
        return text;
    }
};

var app = express();
app.disable('x-powered-by');
app.use(bodyParser.json({limit: conf.request_limit}));

app.use((req, res, next) => {
    // Set the timeout for all HTTP requests
    req.setTimeout(30000, () => {
        logger.error('Request has timed out.');
        res.send(408);
    });
    // Set the server response timeout for all HTTP requests
    res.setTimeout(30000, () => {
        logger.error('Response has timed out.');
        res.send(503);
    });

    res.set("Content-Security-Policy", "default-src 'none'");

    next();
});

app.use(function(req, res, next) {
    res.set("X-Response-Time", new Date().getTime());
    next();
});

var prefix = "/api/v1/users/";

if (conf.security) {
    if(conf.security.blacklist) obj.blacklist(app);

    var permissionMap = [];
    permissionMap.push({
        url: prefix + ":user_id/messages/:mex_id",
        method: "get",
        permissions: ["read"]
    });
    permissionMap.push({
        url: prefix + ":user_id/messages",
        method: "get",
        permissions: ["read"]
    });
    permissionMap.push({
        url: prefix + ":user_id/messages/:mex_uuid",
        method: "delete",
        permissions: ["write"]
    });
    permissionMap.push({
        url: prefix + ":user_id/messages/status",
        method: "put",
        permissions: ["write"]
    });
    permissionMap.push({
        url: prefix + ":user_id/messages/:mex_id",
        method: "put",
        permissions: ["write"]
    });

    obj.security(permissionMap, app);
    app.use(prefix + ':user_id/messages', security_checks.checkHeader);
}

/**
 * convert message taken from db to message well formatted
 * @param m message to  format
 * @returns {*}
 */
function toMessage(m) {
    
    try {
        var mex_io = JSON.parse(decrypt(m.io));
    } catch(e) {
        logger.error("m.io is not a valid JSON: ", m.io, e.message);
        throw e;
    }
    var x = {
        id: m.id,
        bulk_id: m.bulk_id,
        user_id: m.user_id,
        email: {
            to: m.email_to,
            subject: decrypt(m.email_subject),
            body: decrypt(m.email_body),
            template_id: m.email_template_id
        },
        sms: {
            phone: m.sms_phone,
            content: decrypt(m.sms_content)
        },
        push: {
            token: m.push_token,
            title: decrypt(m.push_title),
            body: decrypt(m.push_body),
            call_to_action: m.push_call_to_action
        },
        mex: {
            title: decrypt(m.mex_title),
            body: decrypt(m.mex_body),
            call_to_action: m.mex_call_to_action
        },
        io: mex_io,
        memo: m.memo && typeof m.memo === "object"? JSON.parse(m.memo) : null,
        tag: m.tag? m.tag.join(",") : m.tag,
        correlation_id: m.correlation_id,
        read_at: m.read_at,
        timestamp: m.timestamp
    };
    
    let client_token = decrypt(m.client_token);
    if (client_token) {
        try {
            let payload = JSON.parse(client_token);
            x.sender = payload.preference_service_name;
        } catch (err) {
            logger.error("client_token is not a valid JSON: ", client_token, err.message);
            throw err;
        }
    }
    return x;
}

function getOffset(url, offset, new_offset) {
    if (!url.includes("offset=" + offset)) url += "&offset=" + offset;
    return url.replace("offset=" + offset, "offset=" + new_offset);
}

/**
 * get a specific message from a user
 */
app.get(prefix + ':user_id/messages/:mex_id', async function (req, res, next) {

    if(servicesEnforcedTags === null) return next({type: "system_error", status: 500, message: "internal error"});

    if(!uuid.validate(req.params.mex_id)) {
        logger.warn("not a valid uuid");
        return next({
            type: "client_error",
            status: 400,
            message: escape(req.params.mex_id) + " is not a valid message id"
        });
    }

    let user_id = Utility.hashMD5(req.params.user_id);
    let service_name = req.user.preference_service_name;
    let tenant = req.user.tenant ? req.user.tenant : conf.defaulttenant;

    try {
        let customFilter = null;
        if(servicesEnforcedTags.get(tenant + "_" + service_name)) customFilter = servicesEnforcedTags.get(tenant + "_" + service_name);

        var sql = buildQuery.select().table('messages').filter({
            'user_id': {"eq": user_id},
            'id': {'eq': req.params.mex_id},
            'tenant': {'eq': tenant},
        }).sqlFilter(customFilter).sql;
        logger.debug("query:", sql);
    } catch (err) {
        return next({type: "client_error", status: 400, message: err});
    }

    try {
        var result = await db.execute(sql);

        if (!result || result.length === 0) {
            return next({
                type: "client_error",
                status: 404,
                message: "the user " + escape(req.params.user_id) + " tried to retrieve the message " + escape(req.params.mex_id) + " that doesn't exist"
            });
        }
    } catch (err) {
        return next({type: "db_error", status: 500, message: err});
    }

    let message = result[0];
    message.user_id = req.params.user_id;
    try {
        return next({type: "ok", status: 200, message: toMessage(message)});
    } catch (err) {
        logger.error("system error: ", err.message);
        return next({type: "system_error", status: 500, message: err});
    }
});

/**
 * Cache per il recupero del numero di records totali (select count(*))
 */
class CountData {

    constructor(minutesToLive = 3) {
        /**
         * La cache ha una durata di 3 minuti
         */
        this.millisecondsToLive = minutesToLive * 60 * 1000;
        this.cacheCount = {};
    }

    async getCount(sql) {
        var count = 0;
        /**
         * Se esiste un dato nella cache viene restituito, altrimenti si procede
         *   ad effettuare una select count(*)
         */
        if (this.cacheCount[sql]) {
            var cache = this.cacheCount[sql];
            logger.debug("Found cacheCount: ", cache);
            count = cache.count;
            cache.fetched = new Date().getTime();
        } else {
            var res = await db.execute(sql);
            count = res[0].count;
            var cache = {"count": count, "fetched": new Date().getTime()};
        }
        logger.debug("new cacheCount:", cache);
        this.cacheCount[sql] = cache;
        this.resetCache();
        return count;
    }

    /**
     * Gli elementi vengono rimossi quando la cache non è più valida
     */
    resetCache() {
        Object.entries(this.cacheCount).forEach(([key, value]) => {
            if ((this.cacheCount[key].fetched + this.millisecondsToLive) < new Date().getTime()) {
                delete this.cacheCount[key];
            }
        })
    }
}

var countData = new CountData();

/**
 * get list of messages of the user
 */
app.get(prefix + ':user_id/messages', async function (req, res, next) {

    if(servicesEnforcedTags === null) return next({type: "system_error", status: 500, message: "internal error"});

    let user_id = Utility.hashMD5(req.params.user_id);
    let service_name = req.user.preference_service_name;
    let tenant = req.user.tenant ? req.user.tenant : conf.defaulttenant;

    try {
        var filter = req.query.filter ? JSON.parse(req.query.filter) : {};
        var sort = (req.query.sort ? req.query.sort : "-timestamp") + ",+id";
        var limit = req.query.limit ? parseInt(req.query.limit) : 10;
        var offset = req.query.offset ? parseInt(req.query.offset) : 0;
    } catch(err) {
        logger.error("invalid data in query parameters:", JSON.stringify(req.query));
        return next({type: "client_error", status: 400, message: "invalid data in query parameters"});
    }

    filter.user_id = {eq: user_id};
    filter.tenant = {eq: tenant};

    try {
        let customFilter = null;
        if(servicesEnforcedTags.get(tenant + "_" + service_name)) customFilter = servicesEnforcedTags.get(tenant + "_" + service_name);
        var sqlCount = buildQuery.select().table('messages').filter(filter).sqlFilter(customFilter).count().sql;
        var sql_total = buildQuery.select().table('messages').filter(filter).sqlFilter(customFilter).sort(sort).page(limit, offset).sql;
    } catch (err) {
        logger.error(JSON.stringify(err));
        return next({type: "client_error", status: 400, message: err});
    }

    try {
        logger.debug("SQL get user messages:" + sql_total);
        let t0 = new Date().getTime();
        var resultCount = (await countData.getCount(sqlCount));
        var result = await db.execute(sql_total);
        let t1 = new Date().getTime();
        logger.debug("QUERY EXECUTION TIME: ",(t1-t0)/1000 + "s");

        if (!result || result.length === 0) return next({type: "ok", status: 200, message: []});
    } catch (err) {
        if(err.errno && err.errno === 1054) return next({type: "client_error", status: 400, message: err});
        return next({type: "db_error", status: 500, message: err});
    }

    res.set('total-elements', resultCount);

    let mex_not_read = result.filter( mex => !mex.read_at);
    let mex_not_noticed = result.filter( mex => !mex.tag || !(mex.tag.includes("noticed")));

    res.set('total-elements-not-read', mex_not_read.length);
    res.set('total-elements-not-noticed', mex_not_noticed.length);

    let total_pages = Math.ceil((resultCount) / limit);
    let current_page = Math.round(offset / limit);
    res.set('total-pages', total_pages);
    res.set('current-page', current_page);
    res.set('page-size', limit);

    if (current_page < total_pages - 1) res.set("next-page", getOffset(req.url, offset, offset + limit));
    if (current_page > 0) res.set("previous-page", getOffset(req.url, offset, offset - limit));

    try {
        return next({
            type: "ok", status: 200, message: result.map(e => {
                e.user_id = escape(req.params.user_id);
                return toMessage(e)
            })
        });
    } catch (err) {
        logger.error("system error: ", err.message);
        return next({type: "system_error", status: 500, message: err});
    }
});

/**
 * delete a user message
 */
app.delete(prefix + ':user_id/messages/:mex_uuid', async function (req, res, next) {

    if(servicesEnforcedTags === null) return next({type: "system_error", status: 500, message: "internal error"});

    let user_id = Utility.hashMD5(req.params.user_id);
    let service_name = req.user.preference_service_name;
    let tenant = req.user.tenant ? req.user.tenant : conf.defaulttenant;

    if(!uuid.validate(req.params.mex_uuid)) {
        logger.warn("not a valid uuid");
        return next({
            type: "client_error",
            status: 400,
            message: escape(req.params.mex_uuid) + " is not a valid message id"
        });
    }

    try {
        let customFilter = null;
        if(servicesEnforcedTags.get(tenant + "_" + service_name)) customFilter = servicesEnforcedTags.get(tenant + "_" + service_name);

        var getQuery = buildQuery.select().table('messages').filter({
            "id": {"eq": req.params.mex_uuid},
            "user_id": {"eq": user_id},
            "tenant": {"eq": tenant}
        }).sqlFilter(customFilter).sql;
    } catch (err) {
        return next({type: "client_error", status: 400, message: err});
    }

    try {
        var message = await db.execute(getQuery);
    } catch (err) {
        return next({type: "db_error", status: 500, message: err});
    }

    if (!message || message.length === 0) return next({
        type: "client_error",
        status: 404,
        message: "User message not found"
    });
    var tags = message[0].tag || [];
    if (tags.includes("deleted")) return next({
        type: "client_error",
        status: 400,
        message: "Message already deleted"
    });
    tags.push("deleted");
    
    try {
        var query_update = buildQuery.update().table('messages')
            .set(["tag"], [tags]).filter({"id": {"eq": req.params.mex_uuid}, "user_id": {"eq": user_id}, "tenant": {"eq": tenant}}).sql;
    } catch (err) {
        return next({type: "client_error", status: 400, message: err});
    }

    try {
        await db.execute(query_update);
    } catch (err) {
        return next({type: "db_error", status: 500, message: err});
    }

    next({type: "ok", status: 200, message: "Message deleted"});
});

/**
 * update the status of multiple messages ( only read_at and tags)
 */
app.put(prefix + ':user_id/messages/status', async function (req, res, next) {

    if(servicesEnforcedTags === null) return next({type: "system_error", status: 500, message: "internal error"});

    let user_id = Utility.hashMD5(req.params.user_id);
    let service_name = req.user.preference_service_name;
    let tenant = req.user.tenant ? req.user.tenant : conf.defaulttenant;

    const statusSchema = Joi.array().items(
        Joi.object({
            id: Joi.string().
                guid({
                    version: [
                        'uuidv4'
                    ]
                })
                .required(),
            read_at: Joi.allow(null),
            tag: Joi.string()
                .trim()
                .allow(null)
    }));

    const validateBody = statusSchema.validate(req.body, {abortEarly: false});
    if(validateBody.error) {
        return next({type: "client_error", status: 400, message: validateBody.error.message});
    }

    let messagesToUpdate = validateBody.value.filter( e => e.id && e.id !== "");
    let idMexToGet = messagesToUpdate.map(e => e.id);

    let validKeys = ["read_at","tag"];

    for(let mexToUpdate of messagesToUpdate) {
        let putMex = {};
        Object.assign(putMex,mexToUpdate);

        if(putMex.tag) putMex.tag = putMex.tag.split(",").map(e => e.trim().replace(/-/g, '_').replace(/\s/g, '_')).filter(e => e.length>0);

        Object.keys(putMex).forEach( elem => {
            if(!validKeys.includes(elem)) delete putMex[elem];
        });

        if(putMex.read_at) putMex.read_at = new Date().toISOString();

        try {
            let customFilter = null;
            if(servicesEnforcedTags.get(service_name)) customFilter = servicesEnforcedTags.get(service_name);

            var updateSql = buildQuery.update().table('messages').set(putMex).filter({
                "id": {"eq": mexToUpdate.id},
                "user_id": {"eq": user_id},
                "tenant": {"eq": tenant}
            }).sqlFilter(customFilter).sql;
        } catch (err) {
            return next({type: "client_error", status: 400, message: err});
        }

        try {
            await db.execute(updateSql);
        } catch (err) {
            return next({type: "db_error", status: 500, message: err});
        }
    }

    try {
        var select_sql = buildQuery.select().table("messages").filter({"id": {"in": idMexToGet}, "tenant":{"eq": tenant}}).sql;
    } catch (err) {
        return next({type: "client_error", status: 400, message: err});
    }

    try {
        var result = await db.execute(select_sql);
    } catch (err) {
        return next({type: "db_error", status: 500, message: err});
    }

    let messages = [];

    try {
        result.forEach( e => {
            e = toMessage(e);
            e.user_id = req.params.user_id;
            messages.push(e);
        })
        return next({type: "ok", status: 200, message: messages});
    } catch (err) {
        logger.error("system error: ", err.message);
        return next({type: "system_error", status: 500, message: err});
    }
});

/**
 * update the status of "read" to the message, inserting the timestamp
 */
app.put(prefix + ':user_id/messages/:mex_id', async function (req, res, next) {

    if(servicesEnforcedTags === null) return next({type: "system_error", status: 500, message: "internal error"});

    let user_id = Utility.hashMD5(req.params.user_id);
    let service_name = req.user.preference_service_name;
    let tenant = req.user.tenant ? req.user.tenant : conf.defaulttenant;

    if(!uuid.validate(req.params.mex_id)) {
        logger.warn("not a valid uuid");
        return next({
            type: "client_error",
            status: 400,
            message: escape(req.params.mex_id) + " is not a valid message id"
        });
    }

    let now = new Date().toISOString();
    try {
        let customFilter = null;
        if(servicesEnforcedTags.get(tenant + "_" + service_name)) customFilter = servicesEnforcedTags.get(tenant + "_" + service_name);

        var updateSql = buildQuery.update().table('messages').set(["read_at"], [now]).filter({
            "id": {"eq": req.params.mex_id},
            "user_id": {"eq": user_id},
            "tenant": {"eq": tenant},
            "read_at": {"null": "true"}
        }).sqlFilter(customFilter).sql;
        var select_sql = buildQuery.select().table("messages").filter({"id": {"eq": req.params.mex_id}, "tenant": {"eq": tenant}}).sqlFilter(customFilter).sql;
    } catch (err) {
        return next({type: "client_error", status: 400, message: err});
    }

    try {
        var result = await db.execute(updateSql + ";" + select_sql + ";");
        if (result[1].length === 0) return next({
            type: "client_error",
            status: 404,
            message: "the user " + escape(req.params.user_id) + " tried to update the message " + escape(req.params.mex_id) + " that doesn't exist"
        });

    } catch (err) {
        return next({type: "db_error", status: 500, message: err});
    }
    try {
        let message = toMessage(result[1][0]);
        message.user_id = escape(req.params.user_id);
        return next({type: "ok", status: 200, message: message});
    } catch (err) {
        logger.error("system error: ", err.message);
        return next({type: "system_error", status: 500, message: err});
    }
});

obj.response_handler(app);

app.listen(conf.server_port, function () {
    logger.info("environment:", JSON.stringify(process.env, null, 4));
    logger.info("configuration:", JSON.stringify(conf, null, 4));
    logger.info('Messagestore server listening on port: ', conf.server_port);
});

async function loadServicesEnforcedTags () {
    let options = {
        url: conf.preferences.url + "/services/tags",
        method: "GET",
        headers: {
            'x-authentication': conf.preferences.token,
            'Authorization': 'Basic ' + Buffer.from(conf.preferences.basicauth.username.trim() + ":" + conf.preferences.basicauth.password.trim()).toString('base64')
        },
        json: true
    };
    try {
        let services = await req_promise(options);

        const regex = /tag:'([a-zA-Z0-9_.-]*)'/g;
        servicesEnforcedTags = new Map();
        for(let service of services) {
            if(service.mex_enforced_tags) {
                let mex_enforced_tags_sql = service.mex_enforced_tags.replace(regex, stringToSql);
                servicesEnforcedTags.set(service.name, mex_enforced_tags_sql);
            } 
        }
        logger.debug("loaded services: ", servicesEnforcedTags);
    } catch(e) {
        logger.error("error in loading services: ", e.message);
    }
}

function stringToSql(match, p1, offset, string) {
    return "tag @> array['" + p1 + "']";
}

loadServicesEnforcedTags();
setInterval(loadServicesEnforcedTags, 300 * 1000);