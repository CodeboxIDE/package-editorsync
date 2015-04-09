var diff_match_patch = require("googlediff");

var _ = codebox.require("hr.utils");
var Class = codebox.require("hr.class");
var Queue = codebox.require("hr.queue");
var Q = codebox.require("q");
var hash = codebox.require("utils/hash");
var Socket = codebox.require("core/socket");
var collaborators = codebox.require("core/users");
var user = codebox.require("core/user");
var logging = codebox.require("hr.logger")("filesync");

// hash method for patch
var _hash = function(s) {
    return hash.hex32(hash.crc32(s));
};

var FileSync = Class.extend({
    defaults: {
        'file': null
    },

    // Constructor
    initialize: function() {
        FileSync.__super__.initialize.apply(this, arguments);

        // Diff/Patch calculoator
        this.diff = new diff_match_patch();

        // Current selections
        this.selections = {};

        // Current cursors
        this.cursors = {};
        this.synced = false;

        // File model for this sync
        this.file = null;

        // Environment id used for sync
        this.envId = null;
        this.envOptions = null;

        // Ping has been received
        this.ping = false;

        // List of participants
        this.participants = [];

        // Synchronization state
        this.syncState = false;
        this.timeOfLastLocalChange = Date.now();

        // Modified state
        this.modified = false;

        // Add timer for ping
        this.timer = setInterval(_.bind(this._intervalPing, this), 15*1000);

        // Patch queue
        this.patchQueue = new Queue({
            task: this.patchContent,
            context: this
        });

        // Init file
        if (this.options.file) {
            this.setFile(this.options.file);
        }
    },

    // Chnage modified state
    updateModifiedState: function(s) {
        this.trigger("sync:modified", s);
    },

    // Update current user cursor
    updateUserCursor: function(x, y) {
        if (!this.isSync()) return this;
        return this.sendCursor(x, y);
    },

    // Update current user selection
    updateUserSelection: function(sx, sy, ex, ey) {
        if (!this.isSync()) return this;
        return this.sendSelection(sx, sy, ex, ey);
    },

    /*
     *  Update content of the document (for all collaborators)
     *  Call this method when you detec a change in the editor, ...
     */
    updateContent: function(value) {
        if (!value) return;

        // Old content hash
        this.hash_value_t0 = this.hash_value_t1;

        // New content hash
        logging.log("update content", value);
        this.content_value_t1 = value;
        this.hash_value_t1 = _hash(this.content_value_t1);

        // Create patch
        var patch_list = this.diff.patch_make(this.content_value_t0, this.content_value_t1);
        var patch_text = this.diff.patch_toText(patch_list);

        // Update value
        this.content_value_t0 = this.content_value_t1;

        // Send patch
        this.timeOfLastLocalChange = Date.now();
        this.sendPatch(patch_text, this.hash_value_t0, this.hash_value_t1);

        this.updateModifiedState(true);
    },


    // Maintain connection with ping
    _intervalPing: function(){
        if (!this.isSync()) return;
        if (this.synced == false) {
            this.sendSync();
        } else {
            this.sendPing();
            this.setSyncState(this.ping == true);
            this.ping = false;
        }
    },

    /*
     *  Return true if syncronization is on
     */
    isSync: function() {
        return (this.envId != null);
    },

    /*
     *  Return true if syncronization is established
     */
    isSyncStable: function() {
        return (this.isSync() && this.syncState);
    },

    /*
     *  Define file content
     */
    setContent: function(content) {
        var oldcontent, oldmode_sync = this.sync;

        // Stop sync and update content
        this.sync = false;

        // Calcul patches
        var patches = this.diff.patch_make(this.content_value_t0, content);

        // Calcul new hash
        this.hash_value_t1 = _hash(content);

        oldcontent = this.content_value_t0;
        this.content_value_t0 = content;
        this.content_value_t1 = content;

        // Trigger event to signal we have new content
        this.trigger("content", content, oldcontent, patches);

        // Return to previous sync mode
        this.sync = oldmode_sync;

        return this;
    },

    /*
     *  Apply patch to content
     */
    patchContent: function(patch_data) {
        logging.log("receive patch ", patch_data);

        // Check patch
        if (!patch_data
        || !patch_data.patch
        || !patch_data.hashs.before
        || !patch_data.hashs.after) {
            logging.error("Invalid patch data");
            return false;
        }

        // Check old hash
        if (this.hash_value_t1 == patch_data.hashs.after) {
            // Same content
            return false;
        }

        // Apply on text
        var patches = this.diff.patch_fromText(patch_data.patch);
        var results = this.diff.patch_apply(patches, this.content_value_t0);

        // Test patch application (results[1] contains a list of boolean for patch results)
        if (results.length < 2
        || _.compact(results[1]).length != results[1].length) {
            logging.error("invalid application of ", patches, results);
            this.sendSync();
            return false;
        }

        var newtext = results[0];
        var newtext_hash = _hash(newtext);

        // Check new hash if last changes from this user is older than 2sec
        if ((Date.now() - this.timeOfLastLocalChange) > 2000
        && newtext_hash != patch_data.hashs.after) {
            logging.warn("invalid version -> resync");
            this.sendSync();
            return false;
        }

        // Set editor content
        this.setContent(newtext);
        return true;
    },

    /*
     *  Convert patch to a list of operations
     *  Format for an operation:
     *  {
     *      type: "insert" or "remove",
     *      content: "operation content",
     *      index: (int) position for this operation in the file
     *  }
     */
    patchesToOps: function(patches) {
        return _.chain(patches)
            .map(function(change, i) {
                var diffIndex = change.start1;

                return _.map(change.diffs, function(diff, a) {
                    var content = diff[1];
                    var diffType = diff[0];

                    diffType = diffType > 0 ? "insert" :
                        (diffType == 0 ? null : "remove");

                    var op = !diffType? null : {
                        'type': diffType,
                        'content': content,
                        'index': diffIndex
                    };

                    if (!diffType) {
                        diffIndex = diffIndex + content.length;
                    } else {
                        diffIndex = diffIndex + content.length;
                    }
                    return op;
                });
            })
            .flatten()
            .compact()
            .value();
    },

    /*
     *  Set file for the synschronization
     */
    setFile: function(file, options) {
        var self = this;

        options = _.defaults({}, options || {}, {
            sync: true,
            reset: true,
            autoload: true
        });
        options.reset = options.sync? false : options.reset;

        if (!file) return Q.reject("Invalid editor session to start synchronization");
        if (file.isBuffer()) return Q.reject("Can't start synchronization on a temporary buffer");

        logging.log("init file with options ", options);

        this.file = file;

        this.file.on("set", _.partial(this.setFile, this.file, options), this);

        if (options.autoload) {
            this.on("file:path", function(path) {
                this.file.stat(path);
            }, this);
        }

        // Send close to previous session
        this.send("close");

        // Environment session
        this.envOptions = options
        this.envId = this.file.get("path");

        this.content_value_t0 = this.content_value_t0 || "";
        this.content_value_t1 = this.content_value_t1 || "";

        if (options.reset) {
            this.hash_value_t0 = null;
            this.hash_value_t1 = null;
            this.content_value_t0 = "";
            this.content_value_t1 = "";
        }

        // Signal update
        this.trigger("update:env", options);

        // Reset participants
        this.setParticipants([]);

        logging.log("connecting to the backend");
        return this.socket()
        .then(function(socket) {
            logging.log("connected");

            socket.on('close', function() {
                logging.log("socket disconnect");
                self.setSyncState(false);
            });
            socket.on('data', function(data) {
                if (!self.isSync()) return;

                logging.log("socket receive packet ", data);
                self.ping = true;

                // Calid data
                if (data.action == null || data.environment == null || self.envId != data.environment) {
                    return;
                }

                // Changement file
                if (data.path && (!self.file || data.path != self.file.get("path"))) {
                    self.trigger("file:path", data.path);
                }

                switch (data.action) {
                    case "cursor":
                        if (data.from != user.get("id")) {
                            self.cursorMove(data.from, data.cursor.x, data.cursor.y);
                        }
                        break;
                    case "select":
                        if (data.from != user.get("id")) {
                            self.selectionMove(data.from, data.start.x, data.start.y, data.end.x, data.end.y);
                        }
                        break;
                    case "participants":
                        if (data.participants != null) {
                            self.setParticipants(data.participants)
                        }
                        break;
                    case "sync":
                        if (data.content != null) {
                            self.setContent(data.content);
                            self.synced = true;
                        }
                        if (data.participants != null) {
                            self.setParticipants(data.participants)
                        }
                        if (data.state != null) {
                            self.updateModifiedState(data.state);
                        }
                        break;
                    case "patch":
                        self.patchQueue.defer(data);
                        break;
                    case "modified":
                        if (data.state != null) {
                            self.updateModifiedState(data.state);
                        }
                        break;
                }
                self.setSyncState(true);
            });

            self.sendLoad(self.file.get("path"));
        });
    },

    /*
     *  Return a socket for this connexion
     */
    socket: function() {
        var that = this, d = Q.defer();

        if (this._socket) return Q(this._socket);

        if (!this.envId) {
            return Q.reject(new Error("Need 'envId' to create synchronization socket"))
        }

        var s = new Socket({
            service: "editorsync"
        });

        s.once("open", function() {
            that._socket = s;
            d.resolve(that._socket);
        });

        return d.promise.timeout(5000, "Timeout when connecting to synchronization backend");
    },

    /*
     *  Close connexion with the server
     */
    closeSocket: function() {
        var that = this;
        if (!this._socket) return;
        this._socket.close();
        this_socket = null;
    },

    /*
     *  Enable realtime syncronization
     */
    setSyncState: function(st) {
        this.syncState = st;
        this.trigger("sync:state", this.syncState);
        return this;
    },

    /*
     *  Move a cursor to a position by id
     *  @id : cursor id
     *  @x : position x of the cursor (column)
     *  @y : position y of the cursor (line)
     */
    cursorMove: function(id, x, y) {
        if (user.get("id") == id) {
            return this;
        }

        this.cursors[id] = {
            'x': x,
            'y': y,
            'color': this.participantColor(id)
        };
        this.trigger("cursor:move", id, this.cursors[id]);
        return this;
    },

    /*
     *  Move a selection to a range by id
     *  @id : cursor id
     *  @sx : position start x of the selection (column)
     *  @sy : position start y of the selection (line)
     *  @ex : position end x of the selection (column)
     *  @ey : position end y of the selection (line)
     */
    selectionMove: function(id, sx, sy, ex, ey) {
        if (user.get("id") == id) {
            return this;
        }

        this.selections[id] = {
            'color': this.participantColor(id),
            'start': {
                'x': sx,
                'y': sy
            },
            'end': {
                'x': ex,
                'y': ey
            }
        };
        this.trigger("selection:move", id, this.selections[id]);
        return this;
    },

    /*
     *  Return a cursor position by text index
     *  @index : index of the cursor in the text
     */
    cursorPosByindex: function(index, content) {
        var x = 0;
        var y = 0;

        content = content || this.content_value_t0;

        if (index < 0)
        {
            return [x,y];
        }

        for (var i = 0; i< content.length; i++){
            var c = content[i];
            if (index == i){
                break;
            }
            x = x +1;
            if (c == "\n"){
                x = 0;
                y = y +1;
            }
        }
        return {
            'x': x,
            'y': y
        };
    },

    /*
     *  Return index by cursor position
     *  @cx : cursor position x (column)
     *  @cy : cursor position y (line)
     */
    cursorIndexBypos: function(cx, cy, content){
        var x = 0;
        var y = 0;
        var index = 0;

        content = content || this.content_value_t0;

        for (var i = 0; i< content.length; i++){
            index = i;
            var c = content[i];
            if (cx == x && cy == y){
                break;
            }
            x = x +1;
            if (c == "\n"){
                x = 0;
                y = y +1;
            }
        }
        return index;
    },

    /*
     *  Apply patches to a cursor
     *  @cursor : cursor object {x:, y:}
     *  @operations: operations to paply
     */
    cursorApplyOps: function(cursor, operations, content){
        var cursorIndex, diff;

        content = content || this.content_value_t0;
        operations = operations || [];

        cursorIndex = this.cursorIndexBypos(cursor.x, cursor.y, content);

        for (var i in operations) {
            var op = operations[i];

            if (cursorIndex < op.index) {
                // Before operations -> ignore
            } else {
                diff = (op.type == "insert") ? 1 : -1;
                cursorIndex = cursorIndex + diff * op.content.length;
            }
        }

        return cursorIndex;
    },

    /*
     *  Set lists of participants
     */
    setParticipants: function(participants) {
        // Update participants list
        this.participants = _.chain(participants)
        .map(function(participant, i) {
            participant.user = collaborators.get(participant.userId);
            if (!participant.user) {
                logging.error("participant non user:", participant.userId);
                return null;
            }

            return participant;
        }, this)
        .compact()
        .value();

        this.participantIds = _.pluck(participants, "userId");
        logging.log("update participants", this.participantIds);

        // Signal participant update
        this.trigger("participants");

        // Clear old participants cursors
        _.each(this.cursors, function(cursor, cId) {
            if (_.contains(this.participantIds, cId)) return;

            this.trigger("cursor:remove", cId);
            delete this.cursors[cId];
        }, this);
        _.each(this.selections, function(cursor, cId) {
            if (_.contains(this.participantIds, cId)) return;

            this.trigger("selection:remove", cId);
            delete this.selections[cId];
        }, this);

        // Update all participants cursor/selection
        _.each(this.participants, function(participant) {
            this.cursorMove(participant.userId, participant.cursor.x, participant.cursor.y);
            this.selectionMove(participant.userId,
                participant.selection.start.x, participant.selection.start.y,
                participant.selection.end.x, participant.selection.end.y);
        }, this);

        return this;
    },

    /*
     *  Get participant color
     */
    participantColor: function(pid) {
        return _.reduce(this.participants, function(color, participant) {
            if (participant.userId == pid) {
                return participant.user.get("color");
            }
            return color;
        }, "#ff0000");
    },

    /*
     *  Send to server
     *  @action : action to send
     *  @data : data for this action
     */
    send: function(action, data) {
        if (!this.isSync()) return this;

        if (this.envId != null && action != null) {
            data = _.extend({}, data || {}, {
                'action': action,
                'from': user.get("id"),
                'token': user.get("token"),
                'environment': this.envId
            });

            //logging.log("send packet", data);
            this.socket().then(function(socket) {
                socket.send(data);
            })
        } else {
            this.setSyncState(false);
        }
        return this;
    },

    /*
     *  Send patch to the server
     *  @patch : patch to send
     *  @hash0 : hash before patch
     *  @hash1 : hash after patch
     */
    sendPatch: function(patch, hash0, hash1) {
        return this.send("patch", {
            "patch": patch,
            "hashs": {
                "before": hash0,
                "after": hash1
            }
        });
    },

    /*
     *  Send cursor positions to the server
     *  @cx : position x of the cursor
     *  @cy : position y of the cursor
     */
    sendCursor: function(cx, cy) {
        if (cx == null || cy == null) {
            return;
        }
        return this.send("cursor", {
            "cursor": {
                "x": cx,
                "y": cy
            }
        });
    },

    /*
     *  Send selection to the server
     *  @sx : position start x of the selection (column)
     *  @sy : position start y of the selection (line)
     *  @ex : position end x of the selection (column)
     *  @ey : position end y of the selection (line)
     */
    sendSelection: function(sx, sy, ex, ey) {
        if (sx == null || sy == null || ex == null || ey == null) {
            return;
        }
        return this.send("select", {
            "start": {
                "x": sx,
                "y": sy
            },
            "end": {
                "x": ex,
                "y": ey
            }
        });
    },

    /*
     *  Send ping to the server
     */
    sendPing: function() {
        return this.send("ping");
    },

    /*
     *  Send laod to the server to laod a file
     */
    sendLoad: function(path) {
        return this.send("load", {
            'path': path
        });
    },

    /*
     *  Send request to absolute sync to the server
     */
    sendSync: function() {
        this.send("sync");
        return true;
    },

    /*
     *  Save the file
     */
    save: function() {
        var that = this;

        // If online use the socket event "save"
        var doSave = function(args) {
            that.send("save", args);
            return Q();
        };

        return doSave({});
    },

    /*
     *  Close the connection
     */
    close: function() {
        clearInterval(this.timer);
        this.send("close");
        this.closeSocket();
        this.trigger("close");
        this.stopListening();
        this.off();
    },

    /*
     *  Bind sync with editor
     */
    bindEditor: function(editor) {
        var sync = this;

        // Lock on editor changement
        sync._op_set = false;

        sync.on("update:env", function(options) {
            if (options.reset) {
                sync._op_set = true;
                editor.setContent("");
                sync._op_set = false;
            }
        });

        // Add message
        var message = editor.statusbar.add({
            'content': "Preparing synchronization..."
        });

        // Bind cursor and selection changement -> backend
        sync.listenTo(editor, "selection:change", function(selection) {
            sync.updateUserSelection(selection.start.column, selection.start.row, selection.end.column, selection.end.row);
        });
        sync.listenTo(editor, "cursor:change", function(cursor) {
            sync.updateUserCursor(cursor.column, cursor.row);
        });

        // Bind content changement -> backend
        sync.listenTo(editor, "content:change", function() {
            if (sync._op_set) return;
            sync.updateContent(editor.getContent());
        });

        // Bind closing of tab/file
        sync.listenTo(editor, "tab:close", function() {
            sync.close();
        });

        // Bind changement from backend -> editor
        sync.on("content", function(content, oldcontent, patches) {
            var selection, cursor_lead, cursor_anchor, scroll_y, operations;

            // if resync patches is null
            patches = patches || [];

            // Calcul operaitons from patch
            operations = sync.patchesToOps(patches);

            // Do some operations on selection to preserve selection
            selection = editor.getSelection();

            scroll_y = editor.getScrollTop();

            cursor_lead = selection.start;
            cursor_lead = sync.cursorApplyOps({
                x: cursor_lead.column,
                y: cursor_lead.row
            }, operations, oldcontent);

            cursor_anchor = selection.end;
            cursor_anchor = sync.cursorApplyOps({
                x: cursor_anchor.column,
                y: cursor_anchor.row
            }, operations, oldcontent);

            // Set editor content
            sync._op_set = true;

            // Apply ace delta all in once
            editor.applyDocDeltas(
                _.map(operations, function(op) {
                    return {
                        action: op.type+"Text",
                        range: {
                            start: editor.posFromIndex(op.index),
                            end: editor.posFromIndex(op.index + op.content.length)
                        },
                        text: op.content
                    }
                })
            );

            // Check document content is as expected
            if (editor.getDocContent() != content) {
                logging.error("Invalid operation ", content.length, editor.getDocContent().length);
                editor.setDocContent(content);
                sync.sendSync();
            }
            sync._op_set = false;

            // Move cursors
            editor.setScrollTop(scroll_y);

            cursor_anchor = sync.cursorPosByindex(cursor_anchor, content);
            editor.setSelection({
                row: cursor_anchor.y,
                column: cursor_anchor.x
            });

            cursor_lead = sync.cursorPosByindex(cursor_lead, content);
            editor.setSelection(null, {
                row: cursor_lead.y,
                column: cursor_lead.x
            })
        }, this);

        // Participant cursor moves
        sync.on("cursor:move", function(cId, c) {
            editor.moveCursorExt(cId, c);
        });

        // Participant selection
        sync.on("selection:move", function(cId, c) {
            editor.moveSelectionExt(cId, c);
        });

        // Remove a cursor/selection
        sync.on("cursor:remove selection:remove", function(cId) {
            editor.removeSelectionExt(cId);
            editor.removeCursorExt(cId);
        });

        // Participants list change
        sync.on("participants", function() {
            console.log("sync participants", sync.participants);
        });

        // Bind sync state changement
        sync.on("sync:state", function(state) {
            editor.setReadOnly(!state);
            if (state) {
                message.set("content", "Synchronization is ok");
            } else {
                message.set("content", "Problem with synchronization");
            }
        });

        // Clsoe tab when sync is over
        sync.on("close", function(mode) {
            message.destroy();
            editor.removeAllExt();
        });

        // handle error
        sync.on("error", function(err) {
            codebox.statusbar.show("Error: "+(err.message || err), 3000);
        });

        // Tab states
        sync.on("sync:modified", function(state) {
            editor.setTabState("modified", state);
        });

        // Start sync
        logging.log("start sync with file", editor.model);

        return sync.setFile(editor.model)
        .fail(function(err) {
            message.destroy();

            return Q.reject(err);
        });
    }
});

module.exports = FileSync;
