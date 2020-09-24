var httpReq = require('./libs/http');

var express = require('express');
var path = require('path');
var fs = require('fs');
var logger = require('morgan');
var cookieParser = require('cookie-parser');
var bodyParser = require('body-parser');
var app = express();

var config = require('./config.default.js');
const { stringify } = require('querystring');
const { endianness } = require('os');

app.use(logger('dev'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({
    extended: false
}));
app.use(cookieParser());

HttpUtils = new httpReq(config.oapiHost);

// 获取access_token
let getToken = function (appkey, appsecret, callback){
    HttpUtils.get("/gettoken", {
        "appkey": appkey,
        "appsecret": appsecret,
    }, callback)
}

//使用智能人事接口获取全部员工列表
let getAllUids = function(accessToken, callback, offset, ret){
    if (ret == null) ret = {}
    if (offset == null) offset = 0
    HttpUtils.get("/topapi/smartwork/hrm/employee/queryonjob", {
        "access_token": accessToken,
        "offset": offset,
        "size": 50,
    }, function(err, body){
        if(!err && body && body.result && body.result.data_list) {
            if (body.result.next_cursor)
                getAllUids(accessToken, callback, body.result.next_cursor, ret)
            else
                callback && callback(ret)
        } else {
            callback && callback(ret)
        }
    })
}

//获取部门列表
let getRolesList = function (accessToken, offset, callback){
    HttpUtils.get("/topapi/role/list", {
        "access_token": accessToken,
    }, callback)
}

//获取部门列表
let getUsers = function (roleIds, accessToken, callback){
    let userIds = []
    let names = {}
    let index = 0;
    let count = roleIds.length
    for (let id of roleIds){
        HttpUtils.get("/topapi/role/simplelist", {
            "access_token": accessToken,
            "role_id": id,
        }, function(err, body){
            count--
            if (!err && body.result && body.result.list){
                for (let info of body.result.list){
                    let userId = info.userid
                    if (names[userId]) continue
                    names[userId] = info.name
                    userIds[index] = info.userid
                    index ++
                }
            }
            if (count <= 0) callback({"userIds" : userIds, "names" : names}) 
        })
    }
}

//获取考勤信息
let getAllAttendances = function (userIds, callback){
    let uids;
    let len = userIds.length
    if (len <= 50) uids = userIds
    else{
        uids = []
        let index = 0
        let idx = 0
        for(let i = 0; i++; i<len){
            if (i%50 == 0){
                uids[index] = [[userIds[i]]]
                index++
                idx = 0
            } else {
                idx ++
                uids[index][idx] = [[userIds[i]]]
            }
        }
    }
    
    let length = uids.length
    let attendances = {}
    for (let i = 0; i++; i<length){
        let cb = (i == length - 1) ? callback : null
        getMonthAttendances(attendances, uids[i], accessToken, cb)
    }
}
const formatNumber = (num) => {
	num = num.toString()
	return num[1] ? num : '0' + num
}

//请求一个月的考勤,一次最多请求7天的数据，一个月要分成多次请求
let getMonthAttendances = function(attendances, userIds, accessToken, callback) {
    let date = new Date(), y = date.getFullYear(), m = date.getMonth();
    let year_month = y + "-" + m
    let lastDay = new Date(y, m + 1, 0);

    let maxDay = parseInt(lastDay.getDay())
    let dates = []
    let len = 0
    for (let i = 1; i<maxDay; i+=7) {
        let dateFrom = year_month + "-" + formatNumber(i) + " 00:00:00"
        let to = (i + 7) >= maxDay ? maxDay : (i + 7) 
        let dateTo = year_month + "-" + formatNumber(to) + " 00:00:00"
        console.log("\n----------------dateFrom:"+dateFrom +"-dateTo:"+dateTo)
        dates[len] = {"from":dateFrom, "to": dateTo}
        len++
    }

    if (len == 0 && callback) return callback(attendances)

    for (let i = 0; i<len; i++) {
        let cb = (i == len - 1) ? callback : null
        getAttendances(attendances, accessToken, userIds, dates[i], 0, cb)
    }
}

//请求一次考勤记录
let getAttendances = function(attendances, accessToken, userIds, date, offset, callback) {
    HttpUtils.get("/attendance/list", {
        "access_token": accessToken,
        "workDateFrom": date.from,
        "workDateTo": date.to,
        "userIdList": userIds,
        "offset": offset,
        "limit":50,
    }, function(err, body) {
        if (!err && body && body.recordresult) {
            for (let info of body.recordresult) {
                if (attendances[info.userId]) {
                    let l = attendances[info.userId].length
                    attendances[info.userId][l+1] = info
                } else {
                    attendances[info.userId] = [info]
                }
            }
        }
        if (body && body.hasMore){
            getAttendances(attendances, accessToken, userIds, date, offset * 50, callback)
        } else if (callback) {
            callback(attendances)
        }
    })
}

let analysisAttendances = function(attendances) {

}

// 获取用户信息
app.use('/login', function(req, res) {
    let appkey = config.appkey
    let appsecret = config.appsecret
    getToken(appkey, appsecret, function(err, body) {
        if (!err) {
            var accessToken = body.access_token;
            let usersCb = function(users) {
                if (userIds.length == 0) {
                    res.send('获取员工列表为空或失败')
                    console.log('获取员工列表为空或失败')
                    return
                }
                getAllAttendances(userIds, function(attendances) {
                    let ret = analysisAttendances(attendances)                            
                    res.send(ret);
                })
            }
            if (1+1 == 2) {
                getAllUids(accessToken, usersCb)
            } else {
                getRolesList(accessToken, 0, function(err2, body2) {
                    console.log(body2)
                    if (!err2 && body2.result && body2.result.list) {
                        let roleIds = []
                        let index = 0;
                        for (let groups of body2.result.list) {
                            for (let info of groups.roles) {
                                roleIds[index] = info.id
                                index++
                            }
                        }
                        getUsers(roleIds, accessToken, function(users) {
                            usersCb(users.userIds)
                        })
                    } if (err2) {
                        res.send('获取role列表失败:'+err2)
                        console.log('获取role列表失败:'+err2)
                    } else {
                        res.send('获取role列表为空')
                        console.log('获取role列表为空')
                    }
                });
            }
        } else {
            res.send('获取access_token失败:'+err)
            console.log('获取access_token失败:'+err)
        }
    });

});

app.use(function(req, res, next) {
    res.send('welcome')
});

module.exports = app;