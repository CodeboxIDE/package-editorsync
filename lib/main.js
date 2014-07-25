var Q = require("q");
var _ = require("lodash");

var socket = require("./socket");

module.exports = function(codebox) {
    codebox.logger.log("start editor sync services");
    codebox.socket.service("editorsync", _.partial(socket, codebox));
};
