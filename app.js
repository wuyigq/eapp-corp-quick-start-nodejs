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

    let date = new Date(), y = date.getFullYear(), m = date.getMonth();
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
        rows.push([department, name, attend.overtimes, (attend.overtime/60).toFixed(2), attend.overOrder, len, count.toFixed(2), lateDetail, over1HTime, offDetail, 0])
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
                res.setHeader("Content-Disposition", "attachment; filename=" + "kaoqin.xlsx");
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
    let attendances = {
        "010128586128494718": {
            "MorningNoSign": [],
            "Late": [],
            "SeriousLate": [],
            "Absenteeism": [],
            "EveningNoSign": [],
            "Early": [],
            "overtimes": 1,
            "overtime": 123.73333333333333
        },
        "03042027046553": {
            "MorningNoSign": [],
            "Late": [],
            "SeriousLate": [],
            "Absenteeism": [],
            "EveningNoSign": [11, 18, 19, 23],
            "Early": [],
            "overtimes": 12,
            "overtime": 1988.8166666666666
        },
        "03042027059397": {
            "MorningNoSign": [7, 9],
            "Late": [],
            "Absenteeism": [],
            "EveningNoSign": [7],
            "Early": [],
            "overtimes": 3,
            "overtime": 437.5666666666667
        },
        "03042027074618": {
            "MorningNoSign": [17],
            "Late": [],
            "Absenteeism": [18, 24],
            "EveningNoSign": [17],
            "Early": [],
            "overtimes": 11,
            "overtime": 1907.0333333333333
        },
        "0318325952885716": {
            "MorningNoSign": [16],
            "Late": [],
            "Absenteeism": [],
            "EveningNoSign": [],
            "Early": [],
            "overtimes": 12,
            "overtime": 2117.483333333333
        },
        "040122232636428402": {
            "MorningNoSign": [],
            "Late": [],
            "Absenteeism": [],
            "EveningNoSign": [1],
            "Early": [],
            "overtimes": 2,
            "overtime": 243.26666666666665
        },
        "044709345936237345": {
            "MorningNoSign": [],
            "Late": [],
            "Absenteeism": [],
            "EveningNoSign": [],
            "Early": [],
            "overtimes": 0,
            "overtime": 0
        },
        "0552431205680361": {
            "MorningNoSign": [],
            "Late": [],
            "Absenteeism": [],
            "EveningNoSign": [],
            "Early": [],
            "overtimes": 3,
            "overtime": 437.6166666666667
        },
        "060800203823622783": {
            "MorningNoSign": [],
            "Late": [],
            "Absenteeism": [5, 7],
            "EveningNoSign": [],
            "Early": [21],
            "overtimes": 1,
            "overtime": 213.66666666666666
        },
        "062516116326319963": {
            "MorningNoSign": [17],
            "Late": [],
            "Absenteeism": [27],
            "EveningNoSign": [11, 17],
            "Early": [],
            "overtimes": 1,
            "overtime": 122.58333333333333
        },
        "062950152121550052": {
            "MorningNoSign": [],
            "Late": [],
            "Absenteeism": [],
            "EveningNoSign": [],
            "Early": [],
            "overtimes": 3,
            "overtime": 413.26666666666665
        },
        "08236460192158031": {
            "MorningNoSign": [1, 2],
            "Late": [],
            "SeriousLate": [],
            "Absenteeism": [],
            "EveningNoSign": [1, 2],
            "Early": [],
            "overtimes": 0,
            "overtime": 0
        },
        "0832322429646651": {
            "MorningNoSign": [],
            "Late": [],
            "Absenteeism": [],
            "EveningNoSign": [25],
            "Early": [],
            "overtimes": 1,
            "overtime": 123.63333333333334
        },
        "092617265532539778": {
            "MorningNoSign": [],
            "Late": [],
            "Absenteeism": [21],
            "EveningNoSign": [],
            "Early": [],
            "overtimes": 3,
            "overtime": 398.59999999999997
        },
        "102251660824323275": {
            "MorningNoSign": [],
            "Late": [],
            "Absenteeism": [],
            "EveningNoSign": [5, 19],
            "Early": [],
            "overtimes": 2,
            "overtime": 283.4
        },
        "115768542236772871": {
            "MorningNoSign": [],
            "Late": [],
            "Absenteeism": [2],
            "EveningNoSign": [],
            "Early": [1],
            "overtimes": 12,
            "overtime": 1933.0333333333333
        },
        "1161123726697591": {
            "MorningNoSign": [],
            "Late": [],
            "Absenteeism": [11],
            "EveningNoSign": [],
            "Early": [],
            "overtimes": 0,
            "overtime": 0
        },
        "122347406124178275": {
            "MorningNoSign": [],
            "Late": [],
            "SeriousLate": [],
            "Absenteeism": [],
            "EveningNoSign": [],
            "Early": [],
            "overtimes": 3,
            "overtime": 443.8833333333333
        },
        "131168321922786815": {
            "MorningNoSign": [],
            "Late": [],
            "Absenteeism": [],
            "EveningNoSign": [11],
            "Early": [],
            "overtimes": 14,
            "overtime": 2263.5166666666664
        },
        "1332005102848345": {
            "MorningNoSign": [25],
            "Late": [],
            "SeriousLate": [{
                "day": 2608000
            }],
            "Absenteeism": [],
            "EveningNoSign": [25],
            "Early": [],
            "overtimes": 4,
            "overtime": 710.9666666666667
        },
        "152367371740007428": {
            "MorningNoSign": [],
            "Late": [],
            "SeriousLate": [{
                "day": 2840000
            }],
            "Absenteeism": [],
            "EveningNoSign": [],
            "Early": [],
            "overtimes": 3,
            "overtime": 630.3333333333334
        },
        "153541426933676741": {
            "MorningNoSign": [],
            "Late": [],
            "SeriousLate": [],
            "Absenteeism": [],
            "EveningNoSign": [],
            "Early": [],
            "overtimes": 5,
            "overtime": 699.55
        },
        "173055351226359270": {
            "MorningNoSign": [18],
            "Late": [],
            "SeriousLate": [{
                "day": 2135000
            }],
            "Absenteeism": [8],
            "EveningNoSign": [],
            "Early": [],
            "overtimes": 7,
            "overtime": 910.7666666666667
        },
        "176860561939951833": {
            "MorningNoSign": [],
            "Late": [],
            "SeriousLate": [],
            "Absenteeism": [2],
            "EveningNoSign": [],
            "Early": [],
            "overtimes": 8,
            "overtime": 1101.1
        },
        "183839184232417645": {
            "MorningNoSign": [],
            "Late": [],
            "SeriousLate": [],
            "Absenteeism": [],
            "EveningNoSign": [],
            "Early": [],
            "overtimes": 2,
            "overtime": 333.91666666666663
        },
        "1931460611836848": {
            "MorningNoSign": [],
            "Late": [],
            "SeriousLate": [],
            "Absenteeism": [],
            "EveningNoSign": [],
            "Early": [],
            "overtimes": 2,
            "overtime": 278
        },
        "212649176733487378": {
            "MorningNoSign": [],
            "Late": [],
            "SeriousLate": [],
            "Absenteeism": [],
            "EveningNoSign": [5],
            "Early": [],
            "overtimes": 4,
            "overtime": 634.1666666666667
        },
        "2739174767943071": {
            "MorningNoSign": [],
            "Late": [],
            "SeriousLate": [],
            "Absenteeism": [1, 3, 7, 10],
            "EveningNoSign": [],
            "Early": [],
            "overtimes": 9,
            "overtime": 1952.5499999999997
        },
        "281524142738822940": {
            "MorningNoSign": [15],
            "Late": [],
            "SeriousLate": [{
                "day": 3462000
            }, {
                "day": 3461000
            }, {
                "day": 3266000
            }, {
                "day": 3160000
            }, {
                "day": 3307000
            }, {
                "day": 2701000
            }],
            "Absenteeism": [2, 7],
            "EveningNoSign": [15],
            "Early": [],
            "overtimes": 1,
            "overtime": 159.93333333333334
        },
        "304758564120350840": {
            "MorningNoSign": [],
            "Late": [],
            "SeriousLate": [{
                "day": 2275000
            }],
            "Absenteeism": [],
            "EveningNoSign": [],
            "Early": [],
            "overtimes": 4,
            "overtime": 613.1166666666667
        },
        "121113376439730048": {
            "MorningNoSign": [],
            "Late": [],
            "SeriousLate": [{
                "day": 2756000
            }],
            "Absenteeism": [],
            "EveningNoSign": [],
            "Early": [],
            "overtimes": 9,
            "overtime": 1271.9499999999998
        },
        "146402634237856614": {
            "MorningNoSign": [],
            "Late": [],
            "SeriousLate": [{
                "day": 3057000
            }],
            "Absenteeism": [],
            "EveningNoSign": [24],
            "Early": [],
            "overtimes": 0,
            "overtime": 0
        },
        "5202583632375286": {
            "MorningNoSign": [10],
            "Late": [],
            "SeriousLate": [],
            "Absenteeism": [],
            "EveningNoSign": [],
            "Early": [],
            "overtimes": 0,
            "overtime": 0
        },
        "694446491936278009": {
            "MorningNoSign": [],
            "Late": [],
            "SeriousLate": [],
            "Absenteeism": [],
            "EveningNoSign": [],
            "Early": [],
            "overtimes": 0,
            "overtime": 0
        },
        "08240659031136774": {
            "MorningNoSign": [],
            "Late": [],
            "SeriousLate": [],
            "Absenteeism": [],
            "EveningNoSign": [],
            "Early": [],
            "overtimes": 0,
            "overtime": 0
        }
    }

    let conf = genExcelConfig(attendances, {}, {})
    let excel = nodeExcel.execute(conf)
    res.setHeader('Content-Type', 'application/vnd.openxmlformats');
    res.setHeader("Content-Disposition", "attachment; filename=" + "kaoqing.xlsx");
    res.end(excel, 'binary');
});

module.exports = app;