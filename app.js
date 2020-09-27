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
const { off } = require('process');

app.use(logger('dev'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({
    extended: false
}));
app.use(cookieParser());

let HttpUtils = new httpReq(config.oapiHost);

const formatNumber = (num) => {
	num = num.toString()
	return num[1] ? num : '0' + num
}

// 获取access_token
let getToken = function (appkey, appsecret, callback){
    HttpUtils.get("/gettoken", {
        "appkey": appkey,
        "appsecret": appsecret,
    }, callback)
}

//使用智能人事接口获取全部员工列表
let getAllUsers = function(accessToken, callback, offset, ret){
    if (ret == undefined) ret = []
    HttpUtils.get("/topapi/smartwork/hrm/employee/queryonjob", {
        "access_token": accessToken,
        "status_list": "2,3,5",
        "size": 50,
        "offset": offset,
    }, function(err, body) {
        if (!err && body && body.result && body.result.data_list){
            let len = ret.length
            let data = body.result.data_list
            for(let i = 0; i < data.length; i++){
                ret[len+i] = data[i]
            }
        }
        if (body && body.result && body.result.next_cursor)
            getAllUsers(accessToken, callback, body.result.next_cursor, ret)
        else
            callback && callback(ret)
    })
}

//获取部门列表
let getDepartmentList = function (accessToken, callback){
    HttpUtils.get("/department/list", {
        "access_token": accessToken,
        "fetch_child": true,
    }, function(err, body) {
        console.log(body)
        let department = {}
        if (!err && body && body.department) {
            for (let departs of body.department) {

            }
        }
        callback && callback(department)
    })
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
    let attendances = {}
    getAttendances(attendances, requests, 0, accessToken, callback, 0)
}

//请求一次考勤记录
let getAttendances = function(attendances, requests, index, accessToken, callback, offset) {
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
            getAttendances(attendances, requests, index, accessToken, callback, offset + 50)
        }else if (index < requests.length - 1) {
            getAttendances(attendances, requests, index+1, accessToken, callback, 0)
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
                    let diff = (info.userCheckTime - info.baseCheckTime)/6000
                    //TODO 9:40，10：30，14：00算迟到
                    if (diff > 10) col[info.timeResult].push({[day]:diff})
                } else if (info.timeResult == "Absenteeism") {
                    col.Absenteeism.push(day)
                }
            } else {
                if (info.timeResult == "NotSigned") {
                    col.EveningNoSign.push(day)
                } else if (info.timeResult == "Early") {
                    let diff = (info.baseCheckTime - info.userCheckTime)/6000
                    if (diff > 1) col.Early.push({[day]:diff})
                } else if (info.timeResult == "Absenteeism") {
                    col.Absenteeism.push(day)
                } else if (info.timeResult == "Normal") {
                    //20：30算加班--2*60*60*1000
                    let diff = (info.userCheckTime - info.baseCheckTime)/6000
                    if (diff >= 120) {
                        col.overtimes++
                        col.overtime += diff
                    }
                }
            }
        }
        collect[userId] = col
    }
    console.log(collect)
    return collect
}

let getForm = function(data) {
    let body = '<tr>\
    <td>row 1, cell 1</td>\
    <td>row 1, cell 2</td>\
    </tr>\
    <tr>\
    <td>row 2, cell 1</td>\
    <td>row 2, cell 2</td>\
    </tr>'
    return '<html><title></title><body><table border="1"></table>' + body + '</table></body></html>'
}

// 获取用户信息
app.use('/login', function(req, res) {
    let appkey = config.appkey
    let appsecret = config.appsecret
    getToken(appkey, appsecret, function(err, body) {

        if (err) return res.send('获取access_token失败:' + err)
            
        var accessToken = body.access_token;
        let userCb = function(userIds) {
            if (userIds.length == 0) return res.send('获取员工列表为空或失败')
            getAllAttendances(userIds, accessToken, function(attendances) {
                if (attendances.length == 0) return res.send('获取员工列表为空或失败')
                let ret = analysisAttendances(attendances)                            
                res.send(ret);
            })
        }
        if (1+1 == 20) {
            getAllUsers(accessToken, userCb, 0)
        } else {
            getDepartmentList(accessToken, 0, function(err2, body2) {
                return;
                if (!err2 && body2.result && body2.result.list) {
                    let roleIds = []
                    let index = 0;
                    for (let groups of body2.result.list) {
                        for (let info of groups.roles) {
                            roleIds[index] = info.id
                            index++
                        }
                    }
                    console.log('-----------roleIds--------\n')
                    console.log(roleIds)
                    if (roleIds.length == 0) {
                        res.send('获取role列表为空')
                        return
                    }
                    getUsers(roleIds, accessToken, function(users) {
                        console.log('-----------users--------\n')
                        console.log(users)
                            // userCb(users.userIds)
                    })
                } if (err2) {
                    res.send('获取role列表失败:' + err2)
                } else {
                    console.log(body2)
                    res.send('获取role列表为空')
                }
            });
        }
     });
});

app.use(function(req, res, next) {
    let testData = {
        "010128586128494718": {
            "MorningNoSign": [],
            "Late": [{
                "day": 734000
            }, {
                "day": 1003000
            }],
            "SeriousLate": [],
            "Absenteeism": [],
            "EveningNoSign": [],
            "Early": [],
            "overtimes": 1,
            "overtime": 123.73333333333333
        },
        "03042027046553": {
            "MorningNoSign": [],
            "Late": [{
                "day": 1211000
            }, {
                "day": 1117000
            }, {
                "day": 1426000
            }],
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
            "SeriousLate": [{
                "day": 2936000
            }, {
                "day": 2932000
            }, {
                "day": 3436000
            }],
            "Absenteeism": [],
            "EveningNoSign": [7],
            "Early": [],
            "overtimes": 3,
            "overtime": 437.5666666666667
        },
        "03042027074618": {
            "MorningNoSign": [17],
            "Late": [{
                "day": 865000
            }, {
                "day": 962000
            }],
            "SeriousLate": [{
                "day": 3142000
            }],
            "Absenteeism": [18, 24],
            "EveningNoSign": [17],
            "Early": [],
            "overtimes": 11,
            "overtime": 1907.0333333333333
        },
        "0318325952885716": {
            "MorningNoSign": [16],
            "Late": [],
            "SeriousLate": [{
                "day": 3376000
            }, {
                "day": 2993000
            }],
            "Absenteeism": [],
            "EveningNoSign": [],
            "Early": [],
            "overtimes": 12,
            "overtime": 2117.483333333333
        },
        "040122232636428402": {
            "MorningNoSign": [],
            "Late": [{
                "day": 979000
            }, {
                "day": 1293000
            }, {
                "day": 1655000
            }, {
                "day": 1544000
            }, {
                "day": 1116000
            }, {
                "day": 1136000
            }],
            "SeriousLate": [],
            "Absenteeism": [],
            "EveningNoSign": [1],
            "Early": [],
            "overtimes": 2,
            "overtime": 243.26666666666665
        },
        "044709345936237345": {
            "MorningNoSign": [],
            "Late": [{
                "day": 1356000
            }, {
                "day": 805000
            }, {
                "day": 813000
            }, {
                "day": 1391000
            }],
            "SeriousLate": [{
                "day": 2343000
            }],
            "Absenteeism": [],
            "EveningNoSign": [],
            "Early": [],
            "overtimes": 0,
            "overtime": 0
        },
        "0552431205680361": {
            "MorningNoSign": [],
            "Late": [],
            "SeriousLate": [],
            "Absenteeism": [],
            "EveningNoSign": [],
            "Early": [],
            "overtimes": 3,
            "overtime": 437.6166666666667
        },
        "060800203823622783": {
            "MorningNoSign": [],
            "Late": [{
                "day": 1851000
            }, {
                "day": 931000
            }, {
                "day": 735000
            }, {
                "day": 1276000
            }, {
                "day": 858000
            }, {
                "day": 1128000
            }],
            "SeriousLate": [],
            "Absenteeism": [5, 7],
            "EveningNoSign": [],
            "Early": [21],
            "overtimes": 1,
            "overtime": 213.66666666666666
        },
        "062516116326319963": {
            "MorningNoSign": [17],
            "Late": [{
                "day": 1464000
            }, {
                "day": 1488000
            }],
            "SeriousLate": [],
            "Absenteeism": [27],
            "EveningNoSign": [11, 17],
            "Early": [],
            "overtimes": 1,
            "overtime": 122.58333333333333
        },
        "062950152121550052": {
            "MorningNoSign": [],
            "Late": [{
                "day": 731000
            }],
            "SeriousLate": [],
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
            "Late": [{
                "day": 1722000
            }, {
                "day": 1004000
            }],
            "SeriousLate": [],
            "Absenteeism": [],
            "EveningNoSign": [25],
            "Early": [],
            "overtimes": 1,
            "overtime": 123.63333333333334
        },
        "092617265532539778": {
            "MorningNoSign": [],
            "Late": [{
                "day": 1248000
            }, {
                "day": 1548000
            }],
            "SeriousLate": [{
                "day": 3289000
            }, {
                "day": 2223000
            }],
            "Absenteeism": [21],
            "EveningNoSign": [],
            "Early": [],
            "overtimes": 3,
            "overtime": 398.59999999999997
        },
        "102251660824323275": {
            "MorningNoSign": [],
            "Late": [{
                "day": 1136000
            }],
            "SeriousLate": [],
            "Absenteeism": [],
            "EveningNoSign": [5, 19],
            "Early": [],
            "overtimes": 2,
            "overtime": 283.4
        },
        "115768542236772871": {
            "MorningNoSign": [],
            "Late": [{
                "day": 815000
            }, {
                "day": 863000
            }],
            "SeriousLate": [],
            "Absenteeism": [2],
            "EveningNoSign": [],
            "Early": [1],
            "overtimes": 12,
            "overtime": 1933.0333333333333
        },
        "1161123726697591": {
            "MorningNoSign": [],
            "Late": [{
                "day": 885000
            }, {
                "day": 689000
            }, {
                "day": 1007000
            }, {
                "day": 1280000
            }, {
                "day": 712000
            }, {
                "day": 700000
            }],
            "SeriousLate": [],
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
            "Late": [{
                "day": 835000
            }],
            "SeriousLate": [{
                "day": 3246000
            }, {
                "day": 3479000
            }],
            "Absenteeism": [],
            "EveningNoSign": [11],
            "Early": [],
            "overtimes": 14,
            "overtime": 2263.5166666666664
        },
        "1332005102848345": {
            "MorningNoSign": [25],
            "Late": [{
                "day": 923000
            }, {
                "day": 1138000
            }, {
                "day": 1596000
            }, {
                "day": 1425000
            }, {
                "day": 1202000
            }],
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
            "Late": [{
                "day": 1846000
            }],
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
            "Late": [{
                "day": 1751000
            }],
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
            "Late": [{
                "day": 672000
            }],
            "SeriousLate": [],
            "Absenteeism": [2],
            "EveningNoSign": [],
            "Early": [],
            "overtimes": 8,
            "overtime": 1101.1
        },
        "183839184232417645": {
            "MorningNoSign": [],
            "Late": [{
                "day": 1726000
            }, {
                "day": 1146000
            }, {
                "day": 1396000
            }],
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
            "Late": [{
                "day": 864000
            }, {
                "day": 1342000
            }, {
                "day": 1514000
            }, {
                "day": 958000
            }],
            "SeriousLate": [],
            "Absenteeism": [1, 3, 7, 10],
            "EveningNoSign": [],
            "Early": [],
            "overtimes": 9,
            "overtime": 1952.5499999999997
        },
        "281524142738822940": {
            "MorningNoSign": [15],
            "Late": [{
                "day": 1278000
            }, {
                "day": 1231000
            }, {
                "day": 829000
            }, {
                "day": 995000
            }],
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
            "Late": [{
                "day": 1602000
            }],
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
            "Late": [{
                "day": 1820000
            }],
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
            "SeriousLate": [{
                "day": 2901000
            }],
            "Absenteeism": [],
            "EveningNoSign": [],
            "Early": [],
            "overtimes": 0,
            "overtime": 0
        },
        "08240659031136774": {
            "MorningNoSign": [],
            "Late": [{
                "day": 1392000
            }],
            "SeriousLate": [],
            "Absenteeism": [],
            "EveningNoSign": [],
            "Early": [],
            "overtimes": 0,
            "overtime": 0
        }
    }
    res.send(getForm(testData))
});

module.exports = app;