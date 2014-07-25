define(function(coffeeScript) {
    var commands = codebox.require("core/commands");
    var File = codebox.require("models/file");

    commands.register({
        id: "editor.collaboration.toggle",
        title: "Editor: Toggle Collaboration",
        context: ["editor"],
        run: function(args, context) {

        }
    });
});