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
const e = require('express');

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

//将一维数组，以length为长度进行切割
let spliteArray = function(arr, length){
    let len = arr.length
    if (len <= length || length <= 0) 
        return [arr]

    let ret = []
    let index = 0
    for(let i = 0; i<len; i++) {
        if (i%length == 0) {
            ret[index] = [arr[i]]
            index++
        } else {
            ret[index].push(arr[i])
        }
    }
    return ret
}

//获取请假信息
let getLeaveInfo = function(leaves, userIds, index, offset, accessToken, callback) {
    let date = new Date(), y = date.getFullYear(), m = date.getMonth()
    let start_time = new Date(y, m, 0).valueOf()
    let end_time = new Date(y, m + 1, 0).valueOf()

    HttpUtils.get("/topapi/attendance/getleavestatus", {
        "access_token": accessToken,
        "userid_list": userIds[index],
        "start_time": start_time,
        "end_time": end_time,
        "offset": offset,
        "size": 20,
    }, function(err, body) {
        if (!err && body && body.result && body.result.leave_status) {
            for (let info of body.result.leave_status) {
                if (!leaves[info.userid]) leaves[info.userid] = []
                leaves[info.userid].push(info)
            }
        } 
        if (body && body.result && body.result.has_more == true) {
            getLeaveInfo(leaves, userIds, index, offset+20, accessToken, callback)
        } else if (!err && index < userIds.length - 1) {
            getLeaveInfo(leaves, userIds, index+1, offset, accessToken, callback)
        } else {
            callback && callback(leaves)
        } 
    });
}

//获取个人信息
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

//获取审批表单信息
let getProcessInfo = function(processInfos, processIds, index, accessToken, callback) {
    HttpUtils.post("/topapi/processinstance/get", {"access_token": accessToken}, {
        "process_instance_id": processIds[index],
    }, function(err, body) {
        // console.log(body)
        if (!err && body && body.process_instance) {
            processInfos[processIds[index]] = body.process_instance
        } 
        if (index == processIds.length - 1) callback && callback(processInfos)
        else getProcessInfo(processInfos, processIds, index+1, accessToken, callback)
    });
}

//将考勤通过代办发给员工
let sendAttendences = function(infos, accessToken, callback) {
    let timestamp = new Date().getTime()
    for (let info of infos) {
        sendAttendence(info, accessToken, callback, timestamp)
    }
}

//将考勤通过代办发给员工
let sendAttendence = function(info, accessToken, callback, create_time) {
    create_time = create_time || (new Date().getTime())
    let formItemList = [
        {title:"姓名", content:info.name},
        {title:"迟到次数", content:info.overtimes},
        {title:"迟到时长", content:info.overtime},
        {title:"迟到明细(分钟)", content:info.lateDetail},
        {title:"迟到/早退/缺勤(去掉3次迟到机会)", content:info.lateDetail},
        {title:"请假明细/备注", content:info.name},
        {title:"考勤扣款", content:info.name}
    ]
    HttpUtils.post("/topapi/workrecord/add", {"access_token": accessToken}, {
        "userid": info.userId,
        "create_time": create_time,
        "title": "考勤确认",
        "url": 'TODO',
        "pcUrl": 'TODO',
        "formItemList": formItemList,
        "pc_open_type": 2,
        "biz_id": 'kaoqin',
    }, function(err, body) {
        // console.log(body)
        callback && callback(body)
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
let getAllAttendances = function(uids, accessToken, callback){
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

let analysisAttendances = function(attendances, names) {
    let collect = {}
    let procInstIds = []
    for (let userId in attendances) {
        let col = {MorningNoSign:[], Late:[], MorningAbsent:[], EveningAbsent:[], EveningNoSign:[], Early:[], overtimes:0, overtime:0}
        for (let info of attendances[userId]) {
            let date = new Date(info.workDate)
            let day = date.getDate()
            let procInstId = info.procInstId || ''
            if (info.checkType == "OnDuty") {
                if (info.timeResult == "NotSigned") {
                    col.MorningNoSign.push([day, procInstId])
                } else if (info.timeResult == "Late" || info.timeResult == "SeriousLate") {
                    let diff = (info.userCheckTime - info.baseCheckTime)/60000
                    col.Late.push([day, diff, procInstId])
                } else if (info.timeResult == "Absenteeism") {
                    col.MorningAbsent.push([day, procInstId])
                }
            } else {
                if (info.timeResult == "NotSigned") {
                    col.EveningNoSign.push([day, procInstId])
                } else if (info.timeResult == "Early") {
                    let diff = (info.baseCheckTime - info.userCheckTime)/60000
                    //if (diff > 1) //col.Early.push({[day]:diff})
                    col.Early.push([day, diff, procInstId])
                } else if (info.timeResult == "Absenteeism") {
                    col.EveningAbsent.push([day, procInstId])
                } else if (info.timeResult == "Normal") {
                    //20：00算加班--2*60*60*1000
                    let diff = (info.userCheckTime - info.baseCheckTime)/60000
                    console.log("-------analysisAttendances-------name:"+names[userId]+"---diff:"+diff+"---userCheckTime:"+info.userCheckTime+"---baseCheckTime:"+info.baseCheckTime)
                    if (diff - 90 >= 0) {
                        col.overtimes++
                        col.overtime += (diff - 90)
                    }
                }
            }
            if (info.procInstId) procInstIds.push(procInstId)
        }
        collect[userId] = col
    }
    return {attendances:collect, procInstIds:procInstIds}
}

// 请假信息
let analysisLeave = function(data) {
    let ret = ''
    if (data) {
        for (let info of data) {
            let start = new Date(parseInt(info.start_time))
            let end = new Date(parseInt(info.end_time))
            if (info.duration_unit == "percent_day") {
                ret = ret + (info.duration_percent/100).toFixed(1) + "天(" 
            } else if (info.duration_unit == "percent_hour") {
                ret = ret + (info.duration_percent/100).toFixed(1) + "小时(" 
            }
            if (start.getDate() == end.getDate()) ret = ret + start.getDate() + "日 " + start.getHours() + ":" + end.getMinutes() + "-" + end.getHours() + ":" + end.getMinutes() + "); "
            else ret = ret + start.getDate() + "日" + start.getHours() + ":" + end.getMinutes() + " - " + end.getDate() + "日" + end.getHours() + ":" + end.getMinutes() + "); "
        }
    }
    return ret
}

// 用审批信息纠正异常考勤
let checkProcess = function(name, data, process) {
    return true//TODO
}

// disble interfaace layout.hbs  user config layout: false
let genExcelConfig = function(data, names, departs, leaves, processes) {
    var conf ={};
    conf.stylesXmlFile = "styles.xml";
    conf.name = title;
    conf.cols = [
    {
        caption:'部门(组)',
        type:'string',
        width:15
    },{
        caption:'姓名',
        type:'string',
        width:10
    },{
        caption:'加班次数',
        type:'string',
        width:10
    },{
        caption:'加班时长',
        type:'string',
        width:13
    },{
        caption:'加班排行',
        type:'string',
        width:10
    },{
        caption:'迟到次数',
        type:'string',
        width:10
    },{
        caption:'迟到时长',
        type:'string',
        width:15
    },{
        caption:'迟到明细(分钟)',
        type:'string',
        width:50
    },{
        caption:'迟到/早退/缺勤(去掉3次迟到机会)',
        type:'string',
        width:28
    },{
        caption:'请假明细/备注',
        type:'string',
        width:28
    },{
        caption:'考勤扣款系数',
        type:'number',
        width:10
    }];
    let overtime = []
    for (let userId in data) {
        let attend = data[userId]
        overtime.push({overtime:attend.overtime, userId:userId})
    }
    overtime = overtime.sort(function(a, b) {
        return b.overtime - a.overtime
    })
    for (let index in overtime) {
        let userId = overtime[index].userId
        let attend = data[userId]
        attend.overOrder = parseInt(index) + 1
    }
    let rows = []
    for (let userId in data) {
        let attend = data[userId]
        let len = attend.Late.length
        let totalLate = 0//迟到总时长
        let lateDetail = "" //所有迟到的详情day:time;day:time;...
        let earlyDetail = "" //所有早退的详情day:time;day:time;...
        let absentDetail = "" //所有缺勤的详情day;day
        let nosignDetail = "" //所有缺卡的详情day;day
        let effectsLateDetail = ""   //迟到超过1h次数和三次迟到机会外的迟到(影响money的)
        let lateTimes = 0 //1H以内的迟到次数，用来计算lateDetail和考勤扣款
        for (let late of attend.Late) {
            if (late[2] != '' && checkProcess("late", late)) continue;

            let time = Math.floor(late[1])

            totalLate += time
            lateDetail = lateDetail + time + "(" + late[0] + "日); "

            if (late[1] <= 60 && lateTimes < 3) {
                lateTimes ++
            } else {
                if (effectsLateDetail == '')
                    effectsLateDetail = "迟到：" + time + "(" + late[0] + "日); "
                else
                    effectsLateDetail = effectsLateDetail + time + "(" + late[0] + "日); "
            }
        }
        for (let early of attend.Early) {
            if (early[1] != '' && checkProcess("early", early)) continue;

            let time = Math.floor(early[1])
            if (earlyDetail == '')
                earlyDetail = " 早退：" + time + "(" + early[0] + "日); "
            else
                earlyDetail = earlyDetail + time + "(" + early[0] + "日); "
        }
        for (let absent of attend.MorningAbsent) {
            if (absent[1] != '' && checkProcess("absent", absent)) continue;

            if (absentDetail == '')
                absentDetail = " 缺勤：" + absent[0] + "日早; "
            else
                absentDetail = absentDetail + absent[0]+ "日早; "
        }
        for (let absent of attend.EveningAbsent) {
            if (absent[1] != '' && checkProcess("absent", absent)) continue;

            if (absentDetail == '')
                absentDetail = " 缺勤：" + absent[0] + "日晚; "
            else
                absentDetail = absentDetail + absent[0]+ "日晚; "
        }
        for (let nosign of attend.MorningNoSign) {
            if (nosign[1] != '' && checkProcess("nosign", nosign)) continue;

            if (nosignDetail == '')
                nosignDetail = " 缺卡：" + nosign[0] + "日早; "
            else
                nosignDetail = nosignDetail + nosign[0]+ "日早; "
        }
        for (let nosign of attend.EveningNoSign) {
            if (nosign[1] != '' && checkProcess("nosign", nosign)) continue;

            if (nosignDetail == '')
                nosignDetail = " 缺卡：" + nosign[0] + "日晚; "
            else
                nosignDetail = nosignDetail + nosign[0]+ "日晚; "
        }
        let department = departs[userId] || "unknown"
        let name = names[userId] || "unknown"
        let overtimeCnt = ''
        if (attend.overtime > 0) {
            overtimeCnt = Math.floor(attend.overtime/60) + '小时'
            let minite = Math.floor(attend.overtime)%60
            if (minite > 0)
                overtimeCnt += minite + '分钟'
        }
        if (totalLate > 0) totalLate = totalLate + "分钟"
        else totalLate = ""
        let collect = effectsLateDetail + earlyDetail + absentDetail
        let leaveDetail = analysisLeave(leaves[userId])//请假/调休详情
        rows.push([department, name, attend.overtimes+'', overtimeCnt, attend.overOrder+'', len+'', totalLate, lateDetail, collect, leaveDetail, 0])
        // dddd.push({userId:userId,
        //     department:department,
        //     name:name,
        //     overtimes:attend.overtimes+'',
        //     overtimeCnt:overtimeCnt,
        //     overOrder:attend.overOrder+'',
        //     LateCnt:len+'',
        //     totalLate:totalLate,
        //     lateDetail:lateDetail, effectsOperate:collect, leaveDetail:leaveDetail, factor:0
        // })
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
            let uids = spliteArray(userIds, 50)

            getLeaveInfo({}, uids, 0, 0, accessToken, function(leaves) {

                getAllAttendances(uids, accessToken, function(attendances) {
    
                    if (attendances.length == 0) return res.send('获取员工列表为空或失败')
                    let data = analysisAttendances(attendances, names, departs)
                    let genExcel = function(processes) {
                        let conf = genExcelConfig(data.attendances, names, departs, leaves, processes)
                        let excel = nodeExcel.execute(conf)
                        res.setHeader('Content-Type', 'application/vnd.openxmlformats');
                        res.setHeader("Content-Disposition", "attachment; filename=kaoqin-" + title + ".xlsx");
                        res.end(excel, 'binary');
                    }

                    let procInstIds = data.procInstIds 
                    if (procInstIds.length > 0)
                        getProcessInfo({}, procInstIds, 0, accessToken, genExcel)
                    else
                        genExcel({})
                })
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