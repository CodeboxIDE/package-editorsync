define([
    "src/sync"
], function(FileSync) {
    var commands = codebox.require("core/commands");
    var File = codebox.require("models/file");

    commands.register({
        id: "editor.collaboration.toggle",
        title: "Editor: Toggle Collaboration",
        context: ["editor"],
        run: function(args, editor) {
            // Turn off sync on this file
            if (editor.sync) {
                editor.sync.stop();
                editor.sync = null;
                return;
            }

            editor.sync = new FileSync({
                file: editor.mode
            });
            editor.sync.bindEditor(editor);
        }
    });
});