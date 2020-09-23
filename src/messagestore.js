var commons = require("../../commons/src/commons")
console.log(JSON.stringify(process.env, null, 4));
const conf = commons.merge(require('./conf/mex'), require('./conf/mex-' + (process.env.ENVIRONMENT || 'localhost')));
console.log(JSON.stringify(conf, null, 4));
const obj = commons.obj(conf);

const logger = obj.logger();
const db = obj.db();
const security_checks = obj.security_checks();
const Utility = obj.utility();
const buildQuery = obj.query_builder();

function pattern(x){
    return x.substring(0,x.indexOf("/messages")+"/messages".length) + "*";
}

const util = require("util");

var express = require('express');
var bodyParser = require('body-parser');


const crypto = obj.cryptoAES_cbc();
const encrypt = function (text) {
    if (!text || text === null) return null;
    return crypto.encrypt(text, conf.security.passphrase)
};
const decrypt = function(text){ 
    try{
        if(!text || text ==null) return text;
        return crypto.decrypt(text,conf.security.passphrase)
    }catch(e){
        return text;
    }
};

var hostname = require('os').hostname();
console.log("instrumentazione per appdynamics: ", process.env.APPDYNAMICS_HOSTS, hostname)
logger.info("instrumentazione per appdynamics: ", process.env.APPDYNAMICS_HOSTS, hostname)

var env_dynamics = {
    "dev" : "DEV",
    "tst" : "TEST",
    "prod": "PROD"
}

if(process.env.APPDYNAMICS_HOSTS && process.env.APPDYNAMICS_HOSTS.indexOf(hostname) !== -1){
    require("appdynamics").profile({
        controllerHostName: 'csi-net.saas.appdynamics.com',
        controllerPort: 443,
        controllerSslEnabled: true,
        accountName: 'csi-net',
        accountAccessKey: '00dfb3669f59',
        applicationName: 'NOTIFY_' + env_dynamics[process.env.ENVIRONMENT] + '_CSI-01',
        tierName: 'notify-' + conf.app_name,
        nodeName: 'notify-'+ conf.app_name + '-' + hostname,
        proxyHost: conf.appdynamics.proxyHost,
        proxyPort: conf.appdynamics.proxyPort
    })


}


var app = express();

app.use(bodyParser.json({limit: conf.request_limit}));
app.use(function(req,res,next){
    res.set("X-Response-Time", new Date().getTime());
    next();
});




var prefix = "/api/v1/users/";


// trace request as event
/*const eh = obj.event_handler();
if (eh) app.use((req, res, next) => {
    eh.client_request(req);
    next();
});*/

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
    
    try{
        var mex_io = JSON.parse(decrypt(m.io));
    }catch(e){
        logger.error("m.io is not a valid JSON: ", m.io, e);
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
        memo: m.memo && typeof m.memo === "object"?JSON.parse(m.memo):null,
        tag: m.tag? m.tag.join(","): m.tag,
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
            logger.error("client_token is not a valid JSON: ", client_token, err);
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

    let user_id = Utility.hashMD5(req.params.user_id);
    try {
        var sql = buildQuery.select().table('messages').filter({
            'user_id': {"eq": user_id},
            'id': {'eq': req.params.mex_id}
        }).sql;
        logger.debug("query: ",sql);
    } catch (err) {
        return next({type: "client_error", status: 400, message: err});
    }

    try {
        var result = await db.execute(sql);

        if (!result || result.length === 0) {
            return next({
                type: "client_error",
                status: 404,
                message: "the user " + req.params.user_id + " tried to retrieve the message " + req.params.mex_id + " that doesn't exist"
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
        logger.error("System error: ", err);
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
        logger.debug("new cacheCount: ", cache);
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

    let user_id = Utility.hashMD5(req.params.user_id);

    let filter = req.query.filter ? JSON.parse(req.query.filter) : {};
    let sort = req.query.sort ? req.query.sort : "-timestamp";
    let limit = req.query.limit ? parseInt(req.query.limit) : 10;
    let offset = req.query.offset ? parseInt(req.query.offset) : 0;    

    filter.user_id = {eq: user_id};
    
    let filter_tag = filter.tag;  
    logger.debug("filter tag:",filter.tag);  
    if(filter_tag && filter_tag.match){
//        delete filter.tag;
        var filter_words = filter_tag.match.split(" ");    
    }
    logger.debug("filter words: ",filter_words);

    try {
        var sqlCount = buildQuery.select().table('messages').filter(filter).count().sql;
        var sql_total = buildQuery.select().table('messages').filter(filter).sort(sort).page(limit, offset).sql;
    } catch (err) {
        logger.error(err);
        return next({type: "client_error", status: 400, message: err});
    }
            

    try {
        logger.debug("SQL get user messages:" + sql_total);
        let t0 = new Date().getTime();
        var resultCount = (await countData.getCount(sqlCount));
        var result = await db.execute(sql_total);
        let t1 = new Date().getTime();
        logger.debug("QUERY EXECUTION TIME: ",(t1-t0)/1000 + "s");
                        
        /*if(filter_tag && filter_tag.match) result_total = result_total.filter(e => e.tag).filter( e => {
            let reduced = filter_words.reduce( ((total,fw,index,arr) => {                                    
                if(index === 0 && fw.startsWith("-")) {                    
                    return "!" + e.tag.includes(fw.replace("-"));
                }                
                total+= e.tag.includes(fw.replace('+','').replace('-',''));
                if(arr.length > index +1){                    
                    switch(arr[index+1].charAt(0)){
                        case "+": total +=  " && ";break;
                        case "-": total = "(" + total + ") && !";break;
                        default: total += " || ";break;
                    }
                                        
                }
                return total;
            }),"")
            
            return eval(reduced);
        });*/

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

    let total_pages = Math.trunc((resultCount) / limit) + 1;
    let current_page = Math.round(offset / limit);
    res.set('total-pages', total_pages);
    res.set('current-page', current_page);
    res.set('page-size', limit);


    if (current_page < total_pages - 1) res.set("next-page", getOffset(req.url, offset, offset + limit));
    if (current_page > 0) res.set("previous-page", getOffset(req.url, offset, offset - limit));

    try {
        return next({
            type: "ok", status: 200, message: result.map(e => {
                e.user_id = req.params.user_id;
                return toMessage(e)
            })
        });
    } catch (err) {
        logger.error("System error: ", err);
        return next({type: "system_error", status: 500, message: err});
    }

});



app.delete(prefix + ':user_id/messages/:mex_uuid', async function (req, res, next) {

    let user_id = Utility.hashMD5(req.params.user_id);

    try {
        var getQuery = buildQuery.select().table('messages').filter({
            "id": {"eq": req.params.mex_uuid},
            "user_id": {"eq": user_id}
        }).sql;
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
            .set(["tag"], [tags]).filter({"id": {"eq": req.params.mex_uuid}, "user_id": {"eq": user_id}}).sql;
    } catch (err) {
        return next({type: "client_error", status: 400, message: err});
    }

    try {
        var updateResult = await db.execute(query_update);
    } catch (err) {
        return next({type: "db_error", status: 500, message: err});
    }

    next({type: "ok", status: 200, message: "Message deleted"});

});


/**
 * cambiare tags in tag e corregge example in yaml
 */
/**
 * update the status of multiple messages ( only read_at and tags)
 */
app.put(prefix + ':user_id/messages/status', async function (req, res, next) {

    let user_id = Utility.hashMD5(req.params.user_id);
    let messagesToUpdate = req.body;    

    let now = Utility.getDateFormatted(new Date());

    messagesToUpdate = messagesToUpdate.filter( e => e.id && e.id !== "");
    let idMexToGet = messagesToUpdate.map(e => e.id);

    let validKeys = ["read_at","tag"];

    for(let mexToUpdate of messagesToUpdate) {
        let putMex = {};
        Object.assign(putMex,mexToUpdate);

        if(putMex.tag) putMex.tag = putMex.tag.split(",").map(e => e.trim().replace(/-/g, '_').replace(/\s/g, '_')).filter(e => e.length>0);

        Object.keys(putMex).forEach( elem => {
            if(!validKeys.includes(elem)) delete putMex[elem];
        });

        if(putMex.read_at) putMex.read_at = now;

        try {
            var updateSql = buildQuery.update().table('messages').set(putMex).filter({
                "id": {"eq": mexToUpdate.id},
                "user_id": {"eq": user_id}
            }).sql;
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
        var select_sql = buildQuery.select().table("messages").filter({"id": {"in": idMexToGet}}).sql;
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
        logger.error("System error: ", err);
        return next({type: "system_error", status: 500, message: err});
    }
});



/**
 * update the status of "read" to the message, inserting the timestamp
 */
app.put(prefix + ':user_id/messages/:mex_id', async function (req, res, next) {

    let user_id = Utility.hashMD5(req.params.user_id);

    let now = Utility.getDateFormatted(new Date());
    try {
        var updateSql = buildQuery.update().table('messages').set(["read_at"], [now]).filter({
            "id": {"eq": req.params.mex_id},
            "user_id": {"eq": user_id},
            "read_at": {"null": "true"}
        }).sql;
        var select_sql = buildQuery.select().table("messages").filter({"id": {"eq": req.params.mex_id}}).sql;
    } catch (err) {
        return next({type: "client_error", status: 400, message: err});
    }

    try {
        var result = await db.execute(updateSql + ";" + select_sql + ";");
        if (result[1].length === 0) return next({
            type: "client_error",
            status: 404,
            message: "the user " + req.params.user_id + " tried to update the message " + req.params.mex_id + " that doesn't exist"
        });

    } catch (err) {
        return next({type: "db_error", status: 500, message: err});
    }
    try {
        let message = toMessage(result[1][0]);
        message.user_id = req.params.user_id;
        return next({type: "ok", status: 200, message: message});
    } catch (err) {
        logger.error("System error: ", err);
        return next({type: "system_error", status: 500, message: err});
    }
});

obj.response_handler(app);

app.listen(conf.server_port, function () {
    logger.info("environment: ");
    logger.info(JSON.stringify(process.env, null, 4));
    logger.info("configuration: ");
    logger.info(JSON.stringify(conf, null, 4));
    logger.info('Express server preferences listening on port: ', conf.server_port);
});


