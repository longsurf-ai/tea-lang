const path = require('node:path');
const {workspace} = require('vscode');
const {LanguageClient} = require('vscode-languageclient/node');

let client;

exports.activate = context => {
  const tea = path.resolve(__dirname, '../..');
  client = new LanguageClient(
    'tea',
    'Tea Language Server',
    {
      command: 'node',
      args: ['--import', 'tsx', path.join(tea, 'src/main.ts'), 'lsp'],
      options: {cwd: tea},
    },
    {documentSelector: [{scheme: 'file', language: 'tea'}]},
  );
  // Definitions inside compiler-shipped libraries arrive as tea-lib:/ta.tea
  // URIs; the server serves their text through its one non-standard request.
  const libraries = workspace.registerTextDocumentContentProvider('tea-lib', {
    provideTextDocumentContent: uri =>
      client.sendRequest('tea/libraryText', {uri: uri.toString()}),
  });
  context.subscriptions.push(libraries);
  return client.start();
};

exports.deactivate = () => client?.stop();
