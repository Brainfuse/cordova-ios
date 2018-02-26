/*
       Licensed to the Apache Software Foundation (ASF) under one
       or more contributor license agreements.  See the NOTICE file
       distributed with this work for additional information
       regarding copyright ownership.  The ASF licenses this file
       to you under the Apache License, Version 2.0 (the
       "License"); you may not use this file except in compliance
       with the License.  You may obtain a copy of the License at

         http://www.apache.org/licenses/LICENSE-2.0

       Unless required by applicable law or agreed to in writing,
       software distributed under the License is distributed on an
       "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
       KIND, either express or implied.  See the License for the
       specific language governing permissions and limitations
       under the License.
*/
'use strict';

var fs = require('fs');
var path = require('path');
var util = require('util');
var events = require('cordova-common').events;
var Q = require('q');
var superspawn = require('cordova-common').superspawn;
var CordovaError = require('cordova-common').CordovaError;

Podfile.FILENAME = 'Podfile';

function Podfile (podFilePath, projectName, minDeploymentTarget) {
    this.podToken = '##INSERT_POD##';

    this.path = podFilePath;
    this.projectName = projectName;
    this.minDeploymentTarget = minDeploymentTarget || '9.0';
    this.contents = null;
    this.pods = null;
    this.__dirty = false;

    // check whether it is named Podfile
    var filename = this.path.split(path.sep).pop();
    if (filename !== Podfile.FILENAME) {
        throw new CordovaError(util.format('Podfile: The file at %s is not `%s`.', this.path, Podfile.FILENAME));
    }

    if (!projectName) {
        throw new CordovaError('Podfile: The projectName was not specified in the constructor.');
    }

    if (!fs.existsSync(this.path)) {
        events.emit('verbose', util.format('Podfile: The file at %s does not exist.', this.path));
        events.emit('verbose', 'Creating new Podfile in platforms/ios');
        this.clear();
        this.write();
    } else {
        events.emit('verbose', 'Podfile found in platforms/ios');
        // parse for pods
        this.pods = this.__parseForPods(fs.readFileSync(this.path, 'utf8'));
    }
}

Podfile.prototype.__parseForPods = function (text) {
    // split by \n
    var arr = text.split('\n');

    // aim is to match (space insignificant around the comma, comma optional):
    //     pod 'Foobar', '1.2'
    //     pod 'Foobar', 'abc 123 1.2'
    //     pod 'PonyDebugger', :configurations => ['Debug', 'Beta']
    var podRE = new RegExp('pod \'([^\']*)\'\\s*,?\\s*(.*)');

    // only grab lines that don't have the pod spec'
    return arr.filter(function (line) {
        var m = podRE.exec(line);

        return (m !== null);
    })
        .reduce(function (obj, line) {
            var m = podRE.exec(line);

            if (m !== null) {
                // strip out any single quotes around the value m[2]
                var podSpec = m[2].replace(/^\'|\'$/g, ''); /* eslint no-useless-escape : 0 */
                obj[m[1]] = podSpec; // i.e pod 'Foo', '1.2' ==> { 'Foo' : '1.2'}
            }

            return obj;
        }, {});
};

Podfile.prototype.escapeSingleQuotes = function (string) {
    return string.replace('\'', '\\\'');
};

Podfile.prototype.getTemplate = function () {
    // Escaping possible ' in the project name
    var projectName = this.escapeSingleQuotes(this.projectName);
    return util.format(
        '# DO NOT MODIFY -- auto-generated by Apache Cordova\n' +
            'platform :ios, \'8.0\'\n' +
            'target \'%s\' do\n' +
            '\tproject \'%s.xcodeproj\'\n' +
            '%s\n' +
            'end\n',
        projectName, projectName, this.podToken);
};

Podfile.prototype.addSpec = function (name, spec) {
    name = name || '';
    // optional
    spec = spec; /* eslint no-self-assign : 0 */

    if (!name.length) { // blank names are not allowed
        throw new CordovaError('Podfile addSpec: name is not specified.');
    }

    this.pods[name] = spec;
    this.__dirty = true;

    events.emit('verbose', util.format('Added pod line for `%s`', name));
};

Podfile.prototype.removeSpec = function (name) {
    if (this.existsSpec(name)) {
        delete this.pods[name];
        this.__dirty = true;
    }

    events.emit('verbose', util.format('Removed pod line for `%s`', name));
};

Podfile.prototype.getSpec = function (name) {
    return this.pods[name];
};

Podfile.prototype.existsSpec = function (name) {
    return (name in this.pods);
};

Podfile.prototype.clear = function () {
    this.pods = {};
    this.__dirty = true;
};

Podfile.prototype.destroy = function () {
    fs.unlinkSync(this.path);
    events.emit('verbose', util.format('Deleted `%s`', this.path));
};

Podfile.prototype.write = function () {
    var text = this.getTemplate();
    var self = this;

    var podsString =
    Object.keys(this.pods).map(function (key) {
        var name = key;
        var spec = self.pods[key];

        if (spec.length) {
            if (spec.indexOf(':') === 0) {
                // don't quote it, it's a specification (starts with ':')
                return util.format('\tpod \'%s\', %s', name, spec);
            } else {
                // quote it, it's a version
                return util.format('\tpod \'%s\', \'%s\'', name, spec);
            }
        } else {
            return util.format('\tpod \'%s\'', name);
        }
    }).join('\n');

    text = text.replace(this.podToken, podsString);
    fs.writeFileSync(this.path, text, 'utf8');
    this.__dirty = false;

    events.emit('verbose', 'Wrote to Podfile.');
};

Podfile.prototype.isDirty = function () {
    return this.__dirty;
};

Podfile.prototype.before_install = function (toolOptions) {
    toolOptions = toolOptions || {};

    // Template tokens in order: project name, project name, debug | release
    var template =
    '// DO NOT MODIFY -- auto-generated by Apache Cordova\n' +
    '#include "Pods/Target Support Files/Pods-%s/Pods-%s.%s.xcconfig"';

    var debugContents = util.format(template, this.projectName, this.projectName, 'debug');
    var releaseContents = util.format(template, this.projectName, this.projectName, 'release');

    var debugConfigPath = path.join(this.path, '..', 'pods-debug.xcconfig');
    var releaseConfigPath = path.join(this.path, '..', 'pods-release.xcconfig');

    fs.writeFileSync(debugConfigPath, debugContents, 'utf8');
    fs.writeFileSync(releaseConfigPath, releaseContents, 'utf8');

    return Q.resolve(toolOptions);
};

Podfile.prototype.install = function (requirementsCheckerFunction) {
    var opts = {};
    opts.cwd = path.join(this.path, '..'); // parent path of this Podfile
    opts.stdio = 'pipe';
    var first = true;
    var self = this;

    if (!requirementsCheckerFunction) {
        requirementsCheckerFunction = Q();
    }

    return requirementsCheckerFunction()
        .then(function (toolOptions) {
            return self.before_install(toolOptions);
        })
        .then(function (toolOptions) {
            if (toolOptions.ignore) {
                events.emit('verbose', '==== pod install start ====\n');
                events.emit('verbose', toolOptions.ignoreMessage);
                return Q.resolve();
            } else {
                return superspawn.spawn('pod', ['install', '--verbose'], opts)
                    .progress(function (stdio) {
                        if (stdio.stderr) { console.error(stdio.stderr); }
                        if (stdio.stdout) {
                            if (first) {
                                events.emit('verbose', '==== pod install start ====\n');
                                first = false;
                            }
                            events.emit('verbose', stdio.stdout);
                        }
                    });
            }
        })
        .then(function () { // done
            events.emit('verbose', '==== pod install end ====\n');
        })
        .fail(function (error) {
            throw error;
        });
};

module.exports.Podfile = Podfile;
