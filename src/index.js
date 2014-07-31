define([
    "src/sync"
], function(FileSync) {
    var commands = codebox.require("core/commands");
    var File = codebox.require("models/file");
    var dialogs = codebox.require("utils/dialogs");

    commands.register({
        id: "editor.collaboration.toggle",
        title: "Editor: Toggle Collaboration",
        context: ["editor"],
        run: function(args, editor) {
            // Turn off sync on this file
            if (editor.sync) {
                editor.sync.close();
                editor.sync = null;
                return;
            }

            editor.sync = new FileSync();
            editor.sync.bindEditor(editor)
            .fail(dialogs.error);
        }
    });
});