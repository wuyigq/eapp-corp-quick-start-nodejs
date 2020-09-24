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

//获取部门列表
let getRolesList = function (accessToken, offset, callback){
    HttpUtils.get("/topapi/role/list", {
        "access_token": accessToken,
    }, callback)
}

//获取部门列表
let getUsers = function (roleIds, accessToken, callback){
    let userIds = []
    let names = []
    let index = 0;
    let flag = {}
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
                    if (flag[userId]) continue
                    flag[userId] = true
                    userIds[index] = info.userid
                    names[index] = info.name
                    index ++
                }
            }
            if (count <= 0) callback({"userIds" : userIds, "names" : names}) 
        })
    }
}

//获取考勤信息
let getAllAttendances = function (userIds){
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
    
    for (let i = 0; i++; i<uids.length){
        getMonthAttendances(uids[i], accessToken)
    }
}
const formatNumber = (num) => {
	num = num.toString()
	return num[1] ? num : '0' + num
}

//请求一个月的考勤,一次最多请求7天的数据，一个月要分成多次请求
let getMonthAttendances = function(userIds, accessToken) {
    let date = new Date(), y = date.getFullYear(), m = date.getMonth();
    let year_month = y + "-" + m
    let lastDay = new Date(y, m + 1, 0);

    let maxDay = parseInt(lastDay.getDay())
    let arr = []
    let index = 0
    for (let i = 1; i<maxDay; i+=7) {
        let dateFrom = year_month + "-" + formatNumber(i) + " 00:00:00"
        let to = (i + 7) >= maxDay ? maxDay : (i + 7) 
        let dateTo = year_month + "-" + formatNumber(to) + " 00:00:00"
        console.log("\n----------------dateFrom:"+dateFrom +"-dateTo:"+dateTo)
        arr[index] = {"dateFrom":dateFrom, "dateFrom": dateTo}
    }

    let attendances = {}
    for (let i = 0; i<arr.length; i++) {
        // getAttendances(attendances, accessToken, userIds, arr[i], 0)
        HttpUtils.get("/attendance/list", {
            "access_token": accessToken,
            "workDateFrom": arr[i].dateFrom,
            "workDateTo": arr[i].dateTo,
            "userIdList": userIds,
            "offset": 0,
            "limit":50,
        }, function(err, body){
            if (err) return
            if (body && body.recordresult) {
                for (let info of body.recordresult){
                    if (!attendances[info.userId]) attendances[info.userId] = [info]
                    else {
                        let l = attendances[info.userId].length
                        attendances[info.userId][l+1] = info
                    }
                }
            }
            if (body && body.hasMore){
                //     getAttendances(attendances, accessToken, userIds, date, offset * 50)
                console.log("------------body.hasMore---------")
            }
        })
    }
}

let getAttendances = function(attendances, accessToken, userIds, date, offset) {
    HttpUtils.get("/attendance/list", {
        "access_token": accessToken,
        "workDateFrom": date.dateFrom,
        "workDateTo": date.dateTo,
        "userIdList": userIds,
        "offset": offset,
        "limit":50,
    }, function(err, body){
        if (err) return
        if (body && body.recordresult) {
            for (let info of body.recordresult){
                if (!attendances[info.userId]) attendances[info.userId] = [info]
                else {
                    let l = attendances[info.userId].length
                    attendances[info.userId][l+1] = info
                }
            }
        }
        if (body && body.hasMore)
            getAttendances(attendances, accessToken, userIds, date, offset * 50)
    })
}

let ResponceErr = function(res, errMsg){

}

// 获取用户信息
app.use('/login', function(req, res) {
    let appkey = config.appkey
    let appsecret = config.appsecret
    getToken(appkey, appsecret, function(err, body) {
        if (!err) {
            var accessToken = body.access_token;
            getRolesList(accessToken, 0, function(err2, body2) {
                console.log(body2)
                let roleIds = []
                if (!err2 && body2.result && body2.result.list) {
                    let index = 0;
                    for (let groups of body2.result.list){
                        for (let info of groups.roles) {
                            roleIds[index] = info.id
                            index++
                        }
                    }
                    getUsers(roleIds, accessToken, function(users) {
                        getAllAttendances(users.userIds, function(attendances) {
                            res.send(attendances);
                        })
                    })
                }else{
                    res.send('获取role列表为空或失败')
                    console.err('获取role列表为空或失败');
                }
                
            });
        } else {
            res.send('获取access_token失败')
            console.err('获取access_token失败');
        }
    });

});

app.use(function(req, res, next) {
  res.send('welcome')
});

module.exports = app;