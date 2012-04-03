#!/usr/local/bin/node

var cp = require('child_process');
var fs = require("fs");

var nodebin = "node";
var alive_poll = 500;
var appname = "#m runjs# ";

function getTagPaths(tag){
	var root = process.env.HOME+"/.runjs";
	var dir = root + "/" + tag
	return {
		root_mode : 0770,
		dir_mode : 0770,
		file_mode : 0660,
		root : root,
		dir : dir,
		stdout : dir+"/stdout",
		stderr : dir+"/stderr",
		alive : dir+"/alive",
		pid : dir+"/pid",
		monpid : dir + "/monpid"
	};
}

var colors = { bl:"30", bo:"1", r:"0;31", g:"0;32", y:"0;33", b:"0;34", m:"0;35", c:"0;36", w:"0;37", 
			   br:"1;31", bg:"1;32", by:"1;33", bb:"1;34", bm:"1;35", bc:"1;36", bw:"1;37"} 
			
function out(msg){
	for(var v = Array.prototype.slice.call(arguments), i = 0; i < v.length; i++){
		v[i] = String(v[i]).replace(/\#(\w*)\s/g,function(m, a){
			return "\033[" + (colors[a] || 0) + "m";
		}) + "\033[0m";
	}
	console.log.apply(console, v);
}

function outLen(str){ // decolorize for length
	return str.replace(/\#(\w*)\s/g,"").length;
}

function outPad(str, len, pad){ // decolorized padder
	return (str + Array(len).join(pad || ' ')).slice(0, len + (str.length-outLen(str)) ); 
}

exports.start = function(tag, script, args, cb){
	var tp = getTagPaths(tag);
	
	try{
		if(!fs.statSync(tp.root).isDirectory()) throw(0)
	} catch(e) {
		try{
			fs.mkdirSync(tp.root, tp.root_mode);
		} catch(e) {
			return cb("Cannot create root folder for processes "+tp.root+" \n"+e);
		}
	}

	// check if the script file actually exists before we try to start it
	try{
		if(!fs.statSync(script).isFile())
			throw(0);
	} catch (e) {
		return cb("File does not exist: " +script);
	}
	// first we create the tagdir, operating as a mutexe
	try{
		
		try{fs.unlinkSync(tp.pid)}catch(e){} // TESTING ONLY
		try{fs.unlinkSync(tp.monpid)}catch(e){} // TESTING ONLY
		try{fs.unlinkSync(tp.stdout)}catch(e){} // TESTING ONLY
		try{fs.unlinkSync(tp.stderr)}catch(e){} // TESTING ONLY
		try{fs.unlinkSync(tp.alive)}catch(e){} // TESTING ONLY
		try{fs.rmdirSync(tp.dir);}catch(e){} // TESTING ONLY
		fs.mkdirSync(tp.dir, tp.dir_mode);
	} catch(e){
		// todo, detect dirty state and clean up some shit
		
		// check system startup time for dirty after reboot
		
		return cb("Tag collision detected, please give your process a new #by [tag] # or cleanup the existing process \n"+e)
	}
	// how do we get our own name?
	var newargs = [tag, script]; newargs = newargs.concat(args)
	cp.fork(module.filename, newargs, {env: process.env, cwd: process.cwd});
	
	// we can now auto-tail the process if needed
	cb();
	//	process.exit(0);
	//	startMonitor(tag, script, args);
}

exports.stop = function(tag, cb){
	
}

exports.restart = function(tag, cb){
	
}

exports.find = function(what, cb){
	
}

// hardkill all run.js and run child processes
exports.killAll = function(cb){
	
}

// kill all run.js-like processes and wipe out run.js directory
exports.panic = function(cb){
	exports.list(function(err, rjslist){
		if(err)
			return cb(err);
		
		for(var i = 0;i < rjslist.length; i++){
			var p = rjslist[i];
			if(p.archived) continue;
			if(p.monpid){
				out("#br Killing monitor: # "+p.tag+" "+p.monpid)
				hardKill(p.monpid, function(err,out){
					if(err || out) out("Kill returned: "+err+' '+out)
				});
			}
			if(p.pid){
				out("#br Killing process: # "+p.tag+" "+p.pid)
				hardKill(p.pid, function(err,out){
					if(err || out) out("Kill returned: ")
				});
			}
			// lets archive the process dir
			out("#br Archiving process: # "+p.tag)
			archiveTag(p.tag);
		}
		psInfo(null, function(err, pslist){
			// do a ps based cleanup too
			if(err)
				return cb(err);
			// fetch list
			for(var i = 0;i < pslist.length; i++){
				var p = pslist[i];
				if(p.COMMAND && p.COMMAND.match(/run\.js\s/) && p.PID != process.pid){
					out("#br Wayward run.js killing: # "+p.PID+' '+p.COMMAND)
				}
			}
			cb();
		});
	})
}

exports.list = function(cb){
	// lets list all processes we have, including archived ones
	var tp = getTagPaths("");
	var list = [ ], c = 0;
	fs.readdir(tp.root, function(err, dir){
		if(err)
			return cb(err);
		// for each directory lets list all files to build up our process list
		function last(){
			if(++c == dir.length*3)
				cb(null, list);
		}		
		
		for(var i = 0; i < dir.length; i++){
			var item = list[i] = {
				id: i,
				tag: dir[i], 
				tp: tp = getTagPaths(dir[i]),
				archived : dir[i].indexOf("_archived_") != -1
			};
			try{
				item.pid = fs.readFileSync(tp.pid).toString();
				item.monpid = fs.readFileSync(tp.monpid).toString();
			} catch(e) {
				
			}
			psInfo(item.pid, function(err, obj){
				this.ps = obj;
				last();
			}.bind(item));
			// fstat the pid for start time and uptime
			try{
				item.stime = fs.statSync(tp.monpid).ctime;
				item.atime = fs.statSync(tp.pid).ctime;
			} catch(e){
				
			}
			// read a tail from stdout, stderr and put it in the list
			tail(tp.stdout, 3, function(err, d){
				item.stdout = d;
				last();
			})
			tail(tp.stderr, 3, function(err, d){
				item.stderr = d;
				last();
			})
		}
	})
}

function hardKill(pid, cb){
	cp.exec('kill -9 ' + pid, function (error, stdout, stderr){
		cb(error, stdout||stderr);
	});
}

function psInfo(pid, cb){
	cp.exec('ps aux' + (pid?' '+pid:''), function (error, stdout, stderr){
		var lines = stdout.split('\n');
		if(error || (pid && lines.length != 3))
			return cb(error);
		// parse output of ps aux into an object or array of objects with column name as key
		var out = [], head = lines[0].split(/\s+/);
		for(var row = 1; row < lines.length - 1; row++){
			var obj = out[row - 1] = {};
			var item = lines[row].split(/\s+/);
			for(var col = 0; col < head.length - 1; col++)
				obj[head[col]] = item[col];
			obj[head[col]] = item.slice(col).join(' ');
		}
		cb(null, pid?obj:out);
	});
}

function tail(file, lines, cb){
	var p = cp.spawn('tail',['-n',lines,file]), d = "";
	p.stdout.on('data', function (data) { d += data; });
	p.on('exit', function (code) {
		cb(code !== 0, d);
	});
	return p;
}

function follow(file, lines){
	var p = cp.spawn('tail',['-n',lines,'-f',file]), d = "";
	p.stdout.on('data', function (data) {
		cb(0,data); 
	});
	return p;
}

// functions are used by the monitor
function archiveTag(tag){
	var tp = getTagPaths(tag);
	var tgt =  tp.dir + '_archived_' +new Date().getTime() ;
	// rename the tag directory to archived with a datestamp
	try{
		fs.renameSync(tp.dir, tgt)
	} catch(e){
		// fatal error in the daemon, what do we do?
		log("#br FATAL ERROR: # Cannot archive tag:"+tag+" from: "+tp.dir+" to: "+tgt+"\n"+e);
		process.exit(-1);
	}
}

function startMonitor(tag, script, args){
	if(!tag || !script){
		// we fail!.. no way to return an error
		console.log("Monitor failure, how to return err?");
		return;
	}
	
	var tp = getTagPaths(tag);
	// open stdout and stderr for write
	var stdout = fs.createWriteStream(tp.stdout, { flags:'a+', encoding:null, mode: tp.file_mode});
	var stderr = fs.createWriteStream(tp.stderr, { flags:'a+', encoding:null, mode: tp.file_mode});

	fs.writeFileSync(tp.alive, "1");
	
	var restarting = null;
	
	function aliveFilePoll(){
		// read the alive file, die if its gone, restart if its 0, re
		try{
			var alive = fs.readFileSync(tp.alive);
		} catch(e){
			// error reading alive file, we should kill our process and die
			clearInterval(pi);
			pi = null; 
			return;
		}
		if(alive == "0"){// someone wants us to restart
			clearInterval(pi);
			pi = null; 
			return;
		} else if (alive == "switch"){ // someone wants us to do a graceful shutdown and a switch
			restarting = "switch"
			// lets start ourselves with a new start-rev number, and send ourselves a shutdown signal
			// 
			exports.start("..."  ) + "0"
			// send signal to self
			
		}
		// cant write the file.. have to modify the modifystamp.
		fs.writeFileSync(tp.pid, p.pid);
	}
	
	var pi = setInterval(aliveFilePoll, alive_poll);

	var cmd = Array.prototype.slice(args || []);
	cmd.unshift(script);
	var p = cp.spawn(nodebin, cmd, {env: process.env, cwd: process.cwd});

	fs.writeFileSync(tp.pid, p.pid);
	fs.writeFileSync(tp.monpid, process.pid);
	
	p.stdout.on('data', function (data) {
		stdout.write(data);
	});

	p.stderr.on('data', function (data) {
		stderr.write(data);
	});

	p.on('exit', function (code) {
		if(pi) clearInterval(pi);
		pi = null;
		if(restarting == "switch"){
			// archive and die.
		}
		// if shutdowned with alive 2, just archive self.
		
		// clean up the tagpath unless i want to restart
		startMonitor(tag, script, args);
	});
}

if(module.parent) // are we being used as a module?
	return;

if(process.send){ // we are the result of a fork
	var args = process.argv.slice(2);
	return startMonitor(args[0],args[1],args.slice(2));
}
// ------------------------------------------------------------------------------------------

//	Commandline implementation
	
// ------------------------------------------------------------------------------------------

var args = process.argv.slice(2);

function help(){
	var n = "#m "+appname+"# "
	out("usage: "+n+" #bg [action] #by [tag] #bc [script] #bb [script arguments] ");
	out("")
	out(n+" is the easiest way to run node.js scripts as daemons and monitor them");
	out("a tag is a short identifier you can use to name and select a process, if omitted the script name is the tag");
	out("")
	out(n + " #bg [list] #w list running processes with latest stdout/err")
	out(n + " #bg run #by [tag] #bc jsfile[.js] #bb [arguments] #w starts a process and directly tails it")	
	out(n + " #bg cluster #br nodes # #by [tag] #bc jsfile[.js] #bb [arguments] #w starts a cluster with n nodes")	
	out(n + " #bg start #by [tag] #bc jsfile[.js] #bb [arguments] #w starts a process")	
	out(n + " #bg stop #by tag #w stop particular process")
	out(n + " #bg stopall #w stop all processes")
	out(n + " #bg switch #by tag #w start process again and trigger old one to shutdown with a signal")
	out(n + " #bg panic #w hardkill anything related to run.js")
	out(n + " #bg tail #by tag #w tail process stdout/err")
	out(n + " #bg cleanup #w cleans up stopped processes logfiles")
	out(n + " #bg help #w show this help")
	out("")
}

if(args.length==1 && args[0].match(/^\-+h|^help/)){
	return help();
}

if(args.length==0 || args[0].match(/^(\-l|list)/i)){
	var cols = { 
		'Tag': function(p){ 
			return '#by ' + p.tag + '# '
		},
		'Status': function(p){
			if(p.archived)
				return '#r archived # '
			if(!p.ps)
				return '#br FAIL # '
			return '#bg OK # '
		},
		'PID': function(p){
			return p.pid?(p.archived?("#br ("+p.pid+")# "):p.pid):"#br  X # "; 
		},
		'User': function(p){
			return p.ps?p.ps['USER']:"#br  X # ";
		},
		'CPU': function(p){
			return p.ps?p.ps['%CPU']:"#br  X # ";
		},
		'Mem': function(p){
			return p.ps?p.ps['%MEM']:"#br  X # ";
		},
		'Uptime': function(p){
			var now = new Date().getTime();
			if(!p.stime || !p.atime) 
				return "#br X # ";
			var st = p.stime.getTime(), at = p.atime.getTime();
			var t = Math.floor((at - st)/1000), pre = '', post = '', t2 = Math.floor((now - at)/1000);
			if(t2 > 2) { // t2 is the diff between now and the last alive update. if > 2 secs, the monitor stopped doing that
			 	t = t2;
				pre = '#br ';
				post = ' Monitor down # ';
			}
			var s = t % 60, m = (t - s) % (60*60), h = (t - s - m) % (60*60*24), d = (t - s - m - h);
			return pre+(d?(d/(60*60*24))+'d':'')+(h?(h/(60*60))+'h':'')+(m?(m/60)+'m':'')+('00'+s).slice(-2)+"s"+post;
		},
	}, begin = '' , mid = '  ', end = '';	
	
	exports.list( function(err, procs){
		if(err) return out("#br ERROR # trying to list Run.JS processes: "+err)

		var buf = [], max = {}, last; // format cols and calculate widths
		for(var i = 0, p; i < procs.length; i++){
			var b = buf[i] = {}, p = procs[i];
			for(var c in cols)
				max[c] = Math.max(max[last = c] || 0, outLen(c), outLen(b[c] = String(cols[c](p))||' '));
		}
		
		var s = begin; // build up the header
		for(var c in cols) 
			s += outPad(c, max[c]) + (c == last?end:mid);
		out(s);
		
		for(var i = 0; i < buf.length; i++){ // build up each process line
			var b = buf[i], s = begin;
			for(var c in cols)
				s += outPad(b[c], max[c]) + (c == last?end:mid);
			out(s);
		}
	});
	return;
}

if(args[0].match(/^stop$/i)){
	return exports.stop(args[1],function(err){
		if(err) out("#br ERROR: # "+err)
	});
}

if(args[0].match(/^stopall$/i)){
	return exports.stop(args[1],function(err){
		if(err) out("#br ERROR: # "+err)
	});
}

if(args[0].match(/^panic$/i)){
	return exports.panic(function(err){
		if(err) out("#br ERROR: # "+err)
		else out("Panic cleanup #bg OK# ");
	});
}

if(args[0].match(/^tail$/i)){
	return exports.stop(args[1],function(err){
		if(err) out("#br ERROR: # "+err)
	});
}

if(args[0].match(/^cluster$/i)){
	// lets start 'n' processes by appending a number to our tag
//	for(i=0)
//		exports.start(tag + i);
}

if(args[0].match(/^\-/)){
	out('#br ERROR: # Invalid argument: '+args[0]);
	return help();
}

var startcmd = ""
if(args[0].match(/^(start|run)$/i))
	startcmd = args.shift();

var tag = args[0];
if(args[0].match(/^\[/))
	tag = args.shift().replace(/[^a-zA-Z0-9_]/g,"");

out(appname+" starting script: #bc "+args[0]+ " # with tag #by "+tag);
exports.start(tag, args.shift(), args, function(err){
	if(startcmd == 'run'){ // go tail stdout immediately
	}
	else process.exit(0);
	if(err) out("#br ERROR: # "+err)
});
