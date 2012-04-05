#!/usr/bin/env node

var cp = require("child_process");
var fs = require("fs");
var path = require("path");

var node_bin = "node";
var daemonize_bin = module.filename.replace(/run\.js$/,"")+"daemonize";
var daemonize_c   = daemonize_bin + ".c";
var daemonize_mode = 0550;
var cc_bin		 = "gcc"
var command_poll = 500;
var appname = "#m runjs# ";
var NODAEMONIZE = false; // only use true for debugging the monitor code in the cmdline process

function getTagPaths(tag) {
    var root = process.env.HOME + "/.runjs";
    var dir = root + "/" + tag
    return {
        root_mode: 0777,
        dir_mode: 0777,
        file_mode: 0666,
        root: root,
        dir: dir,
        stdout: dir + "/stdout",
        stderr: dir + "/stderr",
        command: dir + "/command",
        pid: dir + "/pid",
        monpid: dir + "/monpid",
        monlog: root + "/monlog"
    };
}

// ------------------------------------------------------------------------------------------
//	console colors
// ------------------------------------------------------------------------------------------

var colors = {
    bl: "30",   bo: "1",    r: "0;31",    g: "0;32",    y: "0;33",    b: "0;34",    m: "0;35",    c: "0;36",
    w: "0;37",    br: "1;31",    bg: "1;32",    by: "1;33",    bb: "1;34",    bm: "1;35",    bc: "1;36",    bw: "1;37"
}

function out() {
    for (var v = Array.prototype.slice.call(arguments), i = 0; i < v.length; i++) {
        v[i] = String(v[i]).replace(/\#(\w*)\s/g, function(m, a) {
            return "\033[" + (colors[a] || 0) + "m";
        }) + "\033[0m";
    }
	console.log.apply(console, v);
}

function outLen(str) { // decolorize for length
    return str.replace(/\#(\w*)\s/g, "").length;
}

function outPad(str, len, pad) { // decolorized padder
    return (str + Array(len).join(pad || ' ')).slice(0, len + (str.length - outLen(str)));
}

function monlog(tag, msg) {
    var paths = getTagPaths(tag);
    var fd = fs.openSync(paths.monlog, "a+");
    fs.writeSync(fd, "[" + tag + " " + Date.now() + "] " + msg + "\n");
    fs.closeSync(fd);
}

// ------------------------------------------------------------------------------------------
//	tag string ops
// ------------------------------------------------------------------------------------------

function switchTag(tag) {
    var m = tag.match(/^(.+\.)(\d+)$/);
    if(!m)
        return tag + ".1";
    return m[1] + (parseInt(m[2], 10) + 1);
}

function isTagArchived(tag) {
	return tag && tag.indexOf("_archived_") != -1;
}

// ------------------------------------------------------------------------------------------
//	process utils
// ------------------------------------------------------------------------------------------

function kill9(pid, cb) {
    cp.exec('kill -9 ' + pid, function(error, stdout, stderr) {
        cb(error, stdout || stderr);
    });
}

function psaux(pid, cb) {
    cp.exec('ps aux' + (pid ? ' ' + pid : ''), function(error, stdout, stderr) {
        var lines = stdout.split('\n');
        if (error || (pid && lines.length != 3)) return cb(error);
        // parse output of ps aux into an object or array of objects with column name as key
        var out = [],
            head = lines[0].split(/\s+/);
        for (var row = 1; row < lines.length - 1; row++) {
            var obj = out[row - 1] = {};
            var item = lines[row].split(/\s+/);
            for (var col = 0; col < head.length - 1; col++)
            obj[head[col]] = item[col];
            obj[head[col]] = item.slice(col).join(' ');
        }
        cb(null, pid ? obj : out);
    });
}

function tail(file, lines, cb) {
    var p = cp.spawn('tail', ['-n', lines, file]),
        d = "";
    p.stdout.on('data', function(data) {
        d += data;
    });
    p.on('exit', function(code) {
        cb(code !== 0, d);
    });
    return p;
}

function follow(file, lines, cb) {
    var files;
    if(typeof file === "string")
        files = [file];
    else
        files = file;
    var p = cp.spawn('tail', ['-n', lines, '-f'].concat(files));
    p.stdout.on('data', function(data) {
        cb(null, data.toString());
    });
    p.stderr.on('data', function(data) {
        cb(null, data.toString());
    });
    return p;
}

// ------------------------------------------------------------------------------------------
//	tag operations
// ------------------------------------------------------------------------------------------

function tagInfo(tag, cb){
	var lastCall = 0, lastTotal = 0;
	
	var item = {
		tag: tag,
		tp: getTagPaths(tag),
		archived: isTagArchived(tag)
	};
	
    function last() {
        if (++lastCall === lastTotal) cb(null, item);
    }

    var tp = item.tp;
	if(!fs.statSync(tp.dir).isDirectory())
		return cb(null, null);

	try {
	    item.pid = fs.readFileSync(tp.pid).toString();
	    item.monpid = fs.readFileSync(tp.monpid).toString();
	}
	catch (e) { }
	
	if(item.pid){
		lastTotal++;
		psaux(item.pid, function(err, obj) {
		    this.ps = obj;
		    last();
		}.bind(item));
	}
	if(item.monpid){
		lastTotal++;
		psaux(item.monpid, function(err, obj) {
		    this.monps = obj;
		    last();
		}.bind(item));
	}
	// fstat the pid for start time and uptime
	try {
	    item.stime = fs.statSync(tp.monpid).ctime;
	    item.atime = fs.statSync(tp.pid).ctime;
	}
	catch (e) { }
	// read a tail from stdout, stderr and put it in the list
	lastTotal++;
	tail(tp.stdout, 3, function(err, d) {
	    this.stdout = d;
	    last();
	}.bind(item));
	
	lastTotal++;
	tail(tp.stderr, 3, function(err, d) {
	    this.stderr = d;
	    last();
	}.bind(item));
}

function archiveTag(tag) {
    var tp = getTagPaths(tag);
    var tgt = tp.dir + '_archived_' + new Date().getTime();
    // rename the tag directory to archived with a datestamp
    try {
        fs.renameSync(tp.dir, tgt)
    }
    catch (e) {
        // fatal error in the daemon, what do we do?
        monlog("#br FATAL ERROR: # Cannot archive tag:" + tag + " from: " + tp.dir + " to: " + tgt + "\n" + e);
        process.exit(-1);
    }
}

function formatTaglist(out, tags){
	var cols = {
        'Tag': function(p) {
            return '#by ' + p.tag + '# '
        },
        'Status': function(p) {
            if (p.archived) return '#r archived # '
            if (!p.ps) return '#br FAIL # '
            return '#bg OK # '
        },
        'PID': function(p) {
            return p.pid ? (p.archived ? ("#br (" + p.pid + ")# ") : p.pid) : "#br  X # ";
        },
        'MonPID': function(p) {
            return p.monpid ? (p.archived ? ("#br (" + p.monpid + ")# ") : p.monpid) : "#br  X # ";
        },
        'User': function(p) {
            return p.ps ? p.ps['USER'] : "#br  X # ";
        },
        'CPU': function(p) {
            return p.ps ? p.ps['%CPU'] : "#br  X # ";
        },
        'Mem': function(p) {
            return p.ps ? p.ps['%MEM'] : "#br  X # ";
        },
        'Uptime': function(p) {
            var now = new Date().getTime();
            if (!p.stime || !p.atime) return "#br X # ";
            var st = p.stime.getTime(),
                at = p.atime.getTime();
            var t = Math.floor((at - st) / 1000),
                pre = '',
                post = '',
                t2 = Math.floor((now - at) / 1000);
            if (t2 > 2) { // t2 is the diff between now and the last pid update. if > 2 secs, the monitor stopped doing that
                t = t2;
                pre = '#br ';
                post = p.monps ? ' Monitor not updating pid file # ' : ' Monitor down # ';
            }
            var s = t % 60,
                m = (t - s) % (60 * 60),
                h = (t - s - m) % (60 * 60 * 24),
                d = (t - s - m - h);
            return pre + (d ? (d / (60 * 60 * 24)) + 'd' : '') + (h ? (h / (60 * 60)) + 'h' : '') + (m ? (m / 60) + 'm' : '') + ('00' + s).slice(-2) + "s" + post;
        },
        "StdOut": function(p) {
			if(!p.stdout || p.stderr)
				return "#br X # "
            var output = p.stdout + p.stderr;
            output = output.replace(/\n|#/g, " ");
            return output.substring(output.length - 60);
        }
    },
      begin = '',
      mid = '  ',
      end = '';
	
	var buf = [],
		max = {},
		last; // format cols and calculate widths
		
	for (var i = 0, p; i < tags.length; i++) {
	var b = buf[i] = {},
		p = tags[i];
	
	for (var c in cols)
		max[c] = Math.max(max[last = c] || 0, outLen(c), outLen(b[c] = String(cols[c](p)) || ' '));
	}

	var s = begin; // build up the header
	for (var c in cols)
		s += outPad(c, max[c]) + (c == last ? end : mid);
	out(s);

	for (var i = 0; i < buf.length; i++) { // build up each process line
		var b = buf[i],
		s = begin;
		for (var c in cols)
		s += outPad(b[c], max[c]) + (c == last ? end : mid);
		out(s);
	}
}

// ------------------------------------------------------------------------------------------
//	actual monitor function
// ------------------------------------------------------------------------------------------

function startMonitor(tag, script, args) {
    if (!tag || !script) {
        // we fail!.. no way to return an error
        monlog(tag, "Monitor failure, how to return err?");
        return;
    }

    var tp = getTagPaths(tag);
    // open stdout and stderr for write
    var stdout = fs.createWriteStream(tp.stdout, {
        flags: 'a+',
        encoding: null,
        mode: tp.file_mode
    });
    var stderr = fs.createWriteStream(tp.stderr, {
        flags: 'a+',
        encoding: null,
        mode: tp.file_mode
    });

    fs.writeFileSync(tp.command, "running");
    fs.chmodSync(tp.stdout, tp.file_mode);
    fs.chmodSync(tp.stderr, tp.file_mode);
    fs.chmodSync(tp.command, tp.file_mode);

    var restarting = true;
    var pi = setInterval(commandFilePoll, command_poll);
    
    function stopAndArchiveSelf(sig) {
        monlog(tag, "Stop and archive " + script);
        restarting = false;
        clearInterval(pi);
        pi = null;
        p.kill(sig);
    }

    function commandFilePoll() {
        try {
            var command = fs.readFileSync(tp.command).toString();
        }
        catch (e) {
			monlog(tag,"Error reading command file "+e)
            clearInterval(pi);
            pi = null;
            return;
        }
        switch(command) {
            case "running":
                break;
            
            default:
            case "stop":
                stopAndArchiveSelf('SIGTERM');
                break;
                
            case "switch":
                // lets start ourselves with a new start-rev number, and send ourselves a shutdown signal
                //
                var newTag = switchTag(tag);
                clearInterval(pi);
                pi = null;

                exports.start(newTag, script, args, function(err) {
                    if(err)
                        monlog(tag, err); // no return on purpose
                    stopAndArchiveSelf('SIGHUP');
                });

        }
        // cant write the file.. have to modify the modifystamp.
        fs.writeFileSync(tp.pid, ""+p.pid);
    }
    
    
    function gotSig() {
        if(p) {
            p.kill("SIGTERM");
            archiveTag(tag);
            restarting = false;
            NODAEMONIZE = false; // otherwise process doesnt die
        }
        else
            process.exit(0);
    }
    
    process.on("SIGINT", gotSig);
    process.on("SIGTERM", gotSig);
    
    var cmd = args ? args.slice(0) : [];
    cmd.unshift(script);

    var p = cp.spawn(node_bin, cmd, {
        env: process.env,
        cwd: process.cwd()
    });
    
    fs.writeFileSync(tp.monpid, ""+process.pid);
    fs.writeFileSync(tp.pid, ""+p.pid);

    p.stdout.on('data', function(data) {
        stdout.write(data);
    });

    p.stderr.on('data', function(data) {
        stderr.write(data);
    });

    p.on('exit', function(code) {
        console.error("Child process died.");
        stderr.write("-------------------------- Child process ended. ----------------------------\n");
        stdout.end();
        stderr.end();
        if (pi) clearInterval(pi);
        pi = null;
        p = null;
        if (restarting){
			monlog(tag,"Restarting process");
            startMonitor(tag, script, args);
		}
        else {
            archiveTag(tag);
            
            if(!NODAEMONIZE)
                process.exit(0);
        }

    });
}

// ------------------------------------------------------------------------------------------
//	module API
// ------------------------------------------------------------------------------------------

exports.start = function(tag, script, args, cb) {
    var tp = getTagPaths(tag);

    try {
        if (!fs.statSync(tp.root).isDirectory()) throw (0)
    }
    catch (e) {
        try {
            fs.mkdirSync(tp.root, tp.root_mode);
            fs.chmodSync(tp.root, tp.root_mode);
        }
        catch (e) {
            return cb("Cannot create root folder for processes " + tp.root + " \n" + e);
        }
    }

    // check if the script file actually exists before we try to start it
    try {
        if (!fs.statSync(script).isFile()) throw (0);
    }
    catch (e) {
        return cb("File does not exist: " + script);
    }
    // first we create the tagdir, operating as a mutexe
    try {
        fs.mkdirSync(tp.dir, tp.dir_mode);
        fs.chmodSync(tp.dir, tp.dir_mode);
    }
    catch (e) {
        // todo, detect dirty state and clean up some shit
        // check system startup time for dirty after reboot
        return cb("Tag collision detected, please give your process a new #by [tag] # or cleanup the existing process. " + e)
    }
    // how do we get our own name?
    if(NODAEMONIZE) {
    	startMonitor(tag, script, args);
		cb();
    } else {
		// use daemonize to start monitor
		var a = [module.filename, "monitor", tag, script];
        a = a.concat(args);
        var p = cp.spawn(daemonize_bin, a), d = "";
	    p.stdout.on('data', function(data) {
			d += data;
	    });
	    p.stderr.on('data', function(data) {
			d += data;
	    });
	    p.on('exit', function(code) {
			cb(code != 0 ? code + " " + d : null, d);
	    });
		/*
		var newargs = [tag, script];
	    newargs = newargs.concat(args)
		cp.fork(module.filename, newargs, {
            env: process.env,
            cwd: process.cwd
        });*/
    }
    // we can now auto-tail the process if needed
    //	process.exit(0);
}

exports.find = function(tag, cb) {
	var tp = getTagPaths("");
    fs.readdir(tp.root, function(err, dir) {
        if (err) 
			return cb(err);
		for (var i = 0; i < dir.length; i++) {
			if(dir[i].replace(/\.\d+$/, "") === tag) 
				return tagInfo(dir[i], cb);
		}
		cb("Tag not found: " + tag);
	});
};

exports.stop = function(tag, out, cb) {
    exports.find(tag, function(err, p) {
        if(err)
            return cb(err);
        
        out("Stopping process " + p.tag + " with PID " + p.pid + " and monitor " + p.monpid + " ");
        
        try {
            fs.writeFileSync(p.tp.command, "stop");
        } catch(e) {
            cb("Cannot write to command file.");
        }
        var int = setInterval(function() {
            if(!path.exists(p.tp.dir)) {
                clearInterval(int);
                out("OK\n");
                cb();
            }
            else
                out(".");
        }, 100);
    });
}

exports.switch = function(tag, out, cb) {
    exports.find(tag, function(err, p) {
        if(err)
            return cb(err);

		out("Switching tag " + p.tag + " with PID " + p.pid + " and monitor " + p.monpid + " ");
        
        try {
            fs.writeFileSync(p.tp.command, "switch");
        } catch(e) {
            cb("Cannot write to command file.");
        }
        var int = setInterval(function() {
            if(!path.exists(p.tp.dir)) {
                clearInterval(int);
                out("OK\n");
                cb();
            }
            else
                out(".");
        }, 100);
    });
}

exports.restart = function(tag, cb) {

}

exports.killAll = function(cb) {

}

exports.tail = function(tag) {
    exports.find(tag, function(err, p) {
        if(err)
            throw err;
        follow([p.tp.stdout, p.tp.stderr], 20, function(err, entry) {
           process.stdout.write(entry);
        });
    });
}

// kill all run.js-like processes and wipe out run.js directory
exports.panic = function(out, cb) {
    exports.list(false, function(err, rjslist) {
        if (err) return cb(err);

        for (var i = 0; i < rjslist.length; i++) {
            var p = rjslist[i];
            if (p.archived) continue;
            if (p.monpid) {
                out("#br Killing monitor: # " + p.tag + " " + p.monpid)
                kill9(p.monpid, function(err, sout) {
                    if (err || sout) out("Kill returned error.");
                });
            }
            if (p.pid) {
                out("#br Killing process: # " + p.tag + " " + p.pid)
                kill9(p.pid, function(err, sout) {
                    if (err || sout) out("Kill returned.");
                });
            }
            // lets archive the process dir
            out("#br Archiving process: # " + p.tag)
            archiveTag(p.tag);
        }
        psaux(null, function(err, pslist) {
            if (err) return cb(err);
            for (var i = 0; i < pslist.length; i++) {
                var ps = pslist[i];
                if (ps.COMMAND && ps.COMMAND.match(/(\s|\/)run\.js\s/) && ps.PID != process.pid) {
                    out("#br Wayward run.js killing: # " + ps.PID + ' ' + ps.COMMAND)
					kill9(ps.PID,function(err,sout){
						if (err || sout) out("Kill returned.");
					});
                }
            }
            cb();
        });
    })
}

exports.list = function(wantArchived, cb) {
    // lets list all processes we have, including archived ones
    var tp = getTagPaths("");
    fs.readdir(tp.root, function(err, dir) {
        if (err) return cb(err);
        // for each directory lets list all files to build up our process list
        var cbcount = 0, cbtotal = 0, list = [];

		for (var i = 0; i < dir.length; i++) {
			if(isTagArchived(dir[i])){
				if(!wantArchived) continue;
				list.push({tag:dir[i], archived:true})
			} else {;
				cbtotal++;
				tagInfo(dir[i], function(err,t){
					if(t)
						list.push(t);
					if(++cbcount == cbtotal)
						cb(null, list);
				});
			};
		}
		if(dir.length == 0)
			cb(null, null);
	});
}

// ------------------------------------------------------------------------------------------
//	Commandline implementation (calls the API)
// ------------------------------------------------------------------------------------------

if (module.parent) // are we being used as a module?
    return;

// check if daemonize exists, otherwise compile it
if(!path.existsSync(daemonize_bin)){
	out("#br Daemonize binary is not available, attempting to build it....\n");
	var p = cp.spawn(cc_bin, [daemonize_c,"-o",daemonize_bin,"-v"]);

	function stdoutw(d){process.stdout.write(d);}
    p.stdout.on('data',stdoutw);
    p.stderr.on('data',stdoutw);
  	
	p.on('exit',function(code){
		if(code)	
			out("#br Daemonize build failed");
		else{
			if(!path.existsSync(daemonize_bin))
				out("\nDaemonize built, but binary still not found.\n");
			else{
				try{
					fs.chmodSync(daemonize_bin, daemonize_mode);
					out("\nDaemonize built #bg OK #\n");
				}catch(e){
					out("\nDaemonize built, but chmod failed\n");
				}
			}
		}
		process.exit(0);
	});
	return;
}

var args = process.argv.slice(2);

function help() {
    var n = "#m " + appname + "# "
    out("usage: " + n + " #bg [action] #by [tag] #bc [script] #bb [script arguments] ");
    out("")
    out(n + " is the easiest way to run node.js scripts as daemons and monitor them");
    out("a tag is a short identifier you can use to name and select a process, if omitted the script name is the tag");
    out("")
    out(n + " #bg [list] #w list running processes with latest stdout/err")
    out(n + " #bg run #by [tag] #bc jsfile[.js] #bb [arguments] #w starts a process and directly tails it")
    out(n + " #bg cluster #br nodes # #by [tag] #bc jsfile[.js] #bb [arguments] #w starts a cluster with n nodes")
    out(n + " #bg start #by [tag] #bc jsfile[.js] #bb [arguments] #w starts a process")
    out(n + " #bg stop #by tag #w stop particular process")
    out(n + " #bg stopall #w stop all processes")
    out(n + " #bg switch #by tag #w start process again and trigger old one to shutdown with a signal")
    out(n + " #bg panic #w hardkill anything related to "+appname)
    out(n + " #bg tail #by tag #w tail process stdout/err")
    out(n + " #bg cleanup #w cleans up stopped processes logfiles")
    out(n + " #bg help #w show this help")
    out("")
}

if (args.length == 1 && args[0].match(/^\-+h|^help/)) {
    return help();
}

if (args.length == 0 || args[0].match(/^(\-l|list|listall)/i)) {
    exports.list(args[0] && args[0].match(/^listall$/i), function(err, tags) {
        if (err) 
			return out("#br ERROR # trying to list "+appname+" processes: " + err);
        if(!tags || !tags.length) 
			return out("No "+appname+" processes running");
        formatTaglist(out, tags);
    });
    return;
}

if(args[0].match(/^monitor$/i)){
	return startMonitor(args[1], args[2], args.slice(3));	
}

if (args[0].match(/^stop$/i)) {
    return exports.stop(args[1], 
		function(data){
			process.stdout.write(data);
		},
		function(err) {
        	if (err) out("#br ERROR: # " + err)
		});
}

if (args[0].match(/^switch/i)) {
    return exports.switch(args[1],  
		function(data){
			process.stdout.write(data);
		},
		function(err) {
        	if (err) out("#br ERROR: # " + err);
    	});
}

if (args[0].match(/^stopall$/i)) {
    // Not implemented
    console.log("Not implemented");
}

if (args[0].match(/^panic$/i)) {
    return exports.panic(out, function(err) {
        if (err) out("#br ERROR: # " + err)
        else out("Panic cleanup #bg OK# ");
    });
}

if (args[0].match(/^monlog/i)) {
    var paths = getTagPaths("");
    out("Tailing monitor log");
    return follow(paths.monlog, 10, function(err, msg) {
        console.log(msg);
    });
}

if (args[0].match(/^tail$/i)) {
    return exports.tail(args[1], function(err) {
        if (err) out("#br ERROR: # " + err)
    });
}

if (args[0].match(/^cluster$/i)) {
}

if (args[0].match(/^\-/)) {
    out('#br ERROR: # Invalid argument: ' + args[0]);
    return help();
}

var startcmd = ""
if (args[0].match(/^(start|run)$/i)) startcmd = args.shift();

var tag = args[0];
if (args[0].match(/^\[/)) tag = args.shift().replace(/[^a-zA-Z0-9_]/g, "");

out(appname + " starting script: #bc " + args[0] + " # with tag #by " + tag);
exports.start(tag, args.shift(), args, function(err, d) {
    if (err)
        out("#br ERROR: # " + err)
    else if (startcmd == 'run') { // go tail stdout immediately
        return;
    }
    else out("Daemonized with " + d);

    if (!NODAEMONIZE)
        process.exit(0);
});