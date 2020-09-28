var httpReq = require('./libs/http');

var express = require('express');
var path = require('path');
var fs = require('fs');
var logger = require('morgan');
var cookieParser = require('cookie-parser');
var bodyParser = require('body-parser');
var app = express();

var config = require('./config.default.js');
var nodeExcel = require('excel-export');
const { names } = require('debug');

app.use(express.static(path.join(__dirname, 'public')))
app.use(logger('dev'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({
    extended: false
}));
app.use(cookieParser());

let HttpUtils = new httpReq(config.oapiHost);
let title = ""

const formatNumber = (num) => {
	num = num.toString()
	return num[1] ? num : '0' + num
}

let getUserInfo = function(userInfos, userIds, index, accessToken, callback) {
    HttpUtils.get("/user/get", {
        "access_token": accessToken,
        "userid": userIds[index],
    }, function(err, body) {
        if (!err && body) {
            userInfos[body.userid] = body
        } 
        if (index == userIds.length - 1) callback && callback(userInfos)
        else getUserInfo(userInfos, userIds, index+1, accessToken, callback)
    });
}

// 获取access_token
let getToken = function (appkey, appsecret, callback){
    HttpUtils.get("/gettoken", {
        "appkey": appkey,
        "appsecret": appsecret,
    }, callback)
}

//使用智能人事接口获取全部员工列表
let getAllUsers = function(accessToken, offset, ret, res, callback) {
    HttpUtils.get("/topapi/smartwork/hrm/employee/queryonjob", {
        "access_token": accessToken,
        "status_list": "2,3,5",
        "size": 50,
        "offset": offset,
    }, function(err, body) {
        if (!err && body && body.result && body.result.data_list) {
            let len = ret.length
            let data = body.result.data_list
            for(let i = 0; i < data.length; i++) {
                ret[len+i] = data[i]
            }
        }
        if (body && body.errcode != 'ok') {
            return res.send(body)
        } else if (body && body.result && body.result.next_cursor)
            getAllUsers(accessToken, body.result.next_cursor, ret, res, callback)
        else
            callback && callback(ret, {}, {})
    })
}

//获取部门列表
let getDepartmentList = function (accessToken, res, callback) {
    HttpUtils.get("/department/list", {
        "access_token": accessToken,
        "fetch_child": true,
    }, function(err, body) {
        let department = {}
        if (!err && body && body.department) {
            department = body.department
        }
        if (body && body.errcode != 0) {
            return res.send(body)
        } else if (department.length == 0) 
            return res.send('获取部门列表为空')
        else
            callback && callback(department)
    })
}

//获取部门员工列表
let getDepartmentUsers = function (users, department, index, offset, accessToken, callback) {
    HttpUtils.get("/user/simplelist", {
        "access_token": accessToken,
        "department_id": department[index].id,
        "offset": offset,
        "size": 100,
    }, function(err, body) {
        if (!err && body && body.userlist) {
            let depart_name = department[index].name
            for (let info of body.userlist) {
                let userId = info.userid
                users.userIds.push(userId)
                users.names[userId] = info.name
                users.departs[userId] = depart_name
            }
        }
        if (body && body.hasMore) {
            getDepartmentUsers(users, department, index, offset + 100, accessToken, callback)
        } else if (index < department.length - 1) {
            getDepartmentUsers(users, department, index+1, 0, accessToken, callback)
        } else {
            callback && callback(users)
        }
    })
}

//获取考勤信息
let getAllAttendances = function(userIds, accessToken, callback){
    let uids;
    let len = userIds.length
    if (len <= 50) uids = [userIds]
    else{
        uids = []
        let index = 0
        for(let i = 0; i++; i<len){
            if (i%50 == 0){
                uids[index] = [userIds[i]]
                index++
            } else {
                uids[index].push(userIds[i])
            }
        }
    }
    
    let length = uids.length
    if (length == 0) callback && callback()

    let date = new Date(), y = date.getFullYear(), m = date.getMonth()-1
    let year_month = y + "-" + formatNumber(m+1)
    title = year_month
    let lastDay = new Date(y, m + 1, 0);
    let maxDay = parseInt(lastDay.getDate())

    let requests = []
    for (let i = 1; i<maxDay; i+=7) {
        let dateFrom = year_month + "-" + formatNumber(i) + " 00:00:00"
        let to = (i + 6) >= maxDay ? maxDay : (i + 6) 
        let dateTo = year_month + "-" + formatNumber(to) + " 00:00:00"

        for (let userIds of uids) {
            requests.push({userIds:userIds, from:dateFrom, to: dateTo})
        }
    }
    let attendances = {}//接收返回值，就是回调函数的attendances
    getAttendances(attendances, requests, 0, 0, accessToken, callback)
}

//请求一次考勤记录
let getAttendances = function(attendances, requests, index, offset, accessToken, callback) {
    HttpUtils.post("/attendance/list", {"access_token": accessToken}, {
        "workDateFrom": requests[index].from,
        "workDateTo": requests[index].to,
        "userIdList": requests[index].userIds,
        "offset": offset,
        "limit": 50,
    }, function(err, body) {
        if (!err && body && body.recordresult) {
            for (let info of body.recordresult) {
                if (attendances[info.userId]) 
                    attendances[info.userId].push(info)
                else 
                    attendances[info.userId] = [info]
            }
        }
        if (body && body.hasMore) {
            getAttendances(attendances, requests, index, offset + 50, accessToken, callback)
        } else if (index < requests.length - 1) {
            getAttendances(attendances, requests, index+1, 0, accessToken, callback)
        } else {
            callback && callback(attendances)
        }
    })
}

let analysisAttendances = function(attendances) {
    let collect = {}
    for (let userId in attendances) {
        let col = {MorningNoSign:[], Late:[], SeriousLate:[], Absenteeism:[], EveningNoSign:[], Early:[], overtimes:0, overtime:0}
        for (let info of attendances[userId]) {
            let date = new Date(info.workDate)
            let day = date.getDate()
            if (info.checkType == "OnDuty") {
                if (info.timeResult == "NotSigned") {
                    col.MorningNoSign.push(day)
                } else if (info.timeResult == "Late" || info.timeResult == "SeriousLate") {
                    let diff = (info.userCheckTime - info.baseCheckTime)/60000
                    //TODO 9:40，10：30，14：00算迟到
                    if (diff > 10) col.Late.push([day, diff-10])
                } else if (info.timeResult == "Absenteeism") {
                    col.Absenteeism.push(day)
                }
            } else {
                if (info.timeResult == "NotSigned") {
                    col.EveningNoSign.push(day)
                } else if (info.timeResult == "Early") {
                    let diff = (info.baseCheckTime - info.userCheckTime)/60000
                    if (diff > 1) col.Early.push({[day]:diff})
                } else if (info.timeResult == "Absenteeism") {
                    col.Absenteeism.push(day)
                } else if (info.timeResult == "Normal") {
                    //20：30算加班--2*60*60*1000
                    let diff = (info.userCheckTime - info.baseCheckTime)/60000
                    if (diff >= 120) {
                        col.overtimes++
                        col.overtime += diff
                    }
                }
            }
        }
        collect[userId] = col
    }
    return collect
}

// disable interface layout.hbs  user config layout: false
let genExcelConfig = function(data, names, departs) {
    var conf ={};
    conf.stylesXmlFile = "styles.xml";
    conf.name = title;
    conf.cols = [
    {
        caption:'部门(组)',
        type:'string',
        width:78.7109375
    },{
        caption:'姓名',
        type:'string',
        width:28.7109375
    },{
        caption:'加班次数',
        type:'number',
        width:28
    },{
        caption:'加班时长(小时)',
        type:'nubmer',
        width:28.7109375
    },{
        caption:'加班排行',
        type:'number',
        width:28.7109375
    },{
        caption:'迟到次数',
        type:'number',
        width:28.7109375
    },{
        caption:'迟到总时(分钟)',
        type:'number',
        width:48.7109375
    },{
        caption:'迟到明细(分钟)',
        type:'string',
        width:168.7109375
    },{
        caption:'迟到分析',
        type:'number',
        width:28.7109375
    },{
        caption:'请假明细/备注',
        type:'string',
        width:28.7109375
    },{
        caption:'考勤扣款',
        type:'number',
        width:28.7109375
    }];
    let overtime = []
    for (let userId in data) {
        let attend = data[userId]
        overtime.push({overtime:attend.overtime, userId:userId})
    }
    overtime = overtime.sort(function(a, b){
        return b.overtime - a.overtime
    })
    for (let index in overtime) {
        let userId = overtime[index].userId
        let attend = data[userId]
        attend.overOrder = index
    }
    let rows = []
    for (let userId in data) {
        let attend = data[userId]
        let lateDetail = ""
        let len = attend.Late.length
        let count = 0
        let over1HTime = 0
        for (let i in attend.Late) {
            let late = attend.Late[i]
            lateDetail = lateDetail + late[0] + ":" + late[1].toFixed(2)
            if (i < len - 1) lateDetail = lateDetail+ "; "
            count += late[1]
            if (late[1] >= 60) over1HTime++
        }
        let offDetail = 'todo'
        let name = names[userId] || "unknown"
        let department = departs[userId] || "unknown"
        rows.push([department, name, attend.overtimes, (attend.overtime/60).toFixed(2), attend.overOrder+1, len, count.toFixed(2), lateDetail, over1HTime, offDetail, 0])
    }
    conf.rows = rows
    return conf
}

// 获取用户信息
app.use('/kaoqin', function(req, res) {
    let appkey = config.appkey
    let appsecret = config.appsecret
    getToken(appkey, appsecret, function(err, body) {

        if (err) return res.send('获取access_token失败:' + err)

        var accessToken = body.access_token;
        let userCb = function(userIds, names, departs) {
            if (userIds.length == 0) return res.send('获取员工列表为空或失败')
            getAllAttendances(userIds, accessToken, function(attendances) {
                if (attendances.length == 0) return res.send('获取员工列表为空或失败')
                let data = analysisAttendances(attendances)

                let conf = genExcelConfig(data, names, departs)
                let excel = nodeExcel.execute(conf)
                res.setHeader('Content-Type', 'application/vnd.openxmlformats');
                res.setHeader("Content-Disposition", "attachment; filename=kaoqin-" + title + ".xlsx");
                res.end(excel, 'binary');
            })
        }
        if (1+1 == 2) {
            getDepartmentList(accessToken, res, function(department) {
                let retVal = {userIds:[], names:{}, departs:{}}//接收返回值，就是回调函数的users
                getDepartmentUsers(retVal, department, 0, 0, accessToken, function(users) {
                    userCb(users.userIds, users.names, users.departs)
                })
            });
        } else {
            getAllUsers(accessToken, 0, [], res, function(userIds) {
                getUserInfo({}, userIds, 0, accessToken, function(userInfos) {
                    let names = {}
                    let departs = {}
                    for (let info of userInfos) {
                        names[info.userid] = info.name
                        // departs[info.userid] = info.name //TODO
                    }
                    userCb(userIds, names, departs)
                })
            })
        }
     });
});

app.use(function(req, res) {
    res.send('电脑要炸了，赶紧关机')
});

module.exports = app;