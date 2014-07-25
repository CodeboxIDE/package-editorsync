var Q = require("q");
var _ = require("lodash");

var Manager = require('./manager').Manager;

module.exports = function(codebox) {
    codebox.logger.log("start editor sync services");

    // Create manager
    var manager = new Manager(codebox.rpc.get("fs"));

    codebox.socket.service("editorsync", function(socket) {
        var handler = _.partial(manager.handle, socket);

        // Send to sync handler
        socket.on('message', handler);
    });
};
