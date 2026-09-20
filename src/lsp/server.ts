// Purpose: One LSP session — startLanguageServer() registers every handler on a host-supplied connection: open documents, debounced analysis, versioned diagnostics, the position queries and tea/libraryText.

import {fileURLToPath, pathToFileURL} from 'node:url';
import {
  DidChangeWatchedFilesNotification,
  TextDocuments,
  TextDocumentSyncKind,
  type Connection,
  type PublishDiagnosticsParams,
} from 'vscode-languageserver';
import {TextDocument} from 'vscode-languageserver-textdocument';
import {defaultRegistry} from '../loader/loader';
import {analyze, type Analysis} from './analysis';
import {definition, hover, references} from './name-queries';
import {completion, signatureHelp} from './text-queries';

// Coalesces keystrokes; an analysis itself takes 4 to 40 ms.
const DEBOUNCE_MS = 150;

// The loader names a compiler-shipped library `tea-lib/ta.tea`. It has no
// workspace path, so an editor sees it as `tea-lib:/ta.tea`.
const LIBRARY_DIR = 'tea-lib/';
const LIBRARY_SCHEME = 'tea-lib:/';

/**
 * Serves the Language Server Protocol for Tea on `connection`: registers
 * every handler, then starts listening. The host owns the transport and the
 * connection's lifetime; this owns everything said over it. One call is one
 * session with its own open documents, and disposing the connection ends it.
 *
 * - Documents use full-text sync. Each open document has one cached
 *   `Analysis`, dropped when it closes.
 * - Diagnostics are pushed, never pulled: 150 ms after the last change, with
 *   the document version they were computed from, and again for every open
 *   document on `workspace/didChangeWatchedFiles`. Closing a document clears
 *   them. Analysis is synchronous, so a published version never goes back.
 * - Hover, definition, references, completion and signature help answer
 *   against the current text: a cache older than the document is refreshed
 *   first.
 * - A `file:` URI is analyzed under its file-system path, so relative imports
 *   resolve against the real file; any other URI is its own filename. A
 *   definition in a compiler-shipped library is a `tea-lib:/ta.tea` location,
 *   and `tea/libraryText`, the one non-standard request, takes `{uri}` and
 *   returns that library's source text, or null.
 * - A throw while analyzing or answering is a compiler defect. It is logged
 *   to the client, the request answers null, the diagnostics published
 *   before stay, and the session goes on.
 *
 * @example
 * ```ts
 * import {createConnection} from 'vscode-languageserver/node';
 *
 * // `tea lsp`: one session over stdio. An embedding host passes a connection
 * // made from its own MessageReader and MessageWriter instead.
 * startLanguageServer(createConnection(process.stdin, process.stdout));
 * ```
 */
export function startLanguageServer(connection: Connection): void {
  const documents = new TextDocuments(TextDocument);
  const analyses = new Map<
    string,
    {readonly version: number; readonly analysis: Analysis}
  >();
  const debounces = new Map<string, ReturnType<typeof setTimeout>>();
  let registersFileWatcher = false;

  // Answers `question` from the analysis of the document's current text.
  function ask<T>(
    uri: string,
    question: (analysis: Analysis, document: TextDocument) => T,
  ): T | null {
    const document = documents.get(uri);
    if (document === undefined) {
      return null;
    }
    try {
      let cached = analyses.get(uri);
      if (cached?.version !== document.version) {
        const source = document.getText();
        cached = {
          version: document.version,
          analysis: analyze({filename: filenameOf(uri), source}),
        };
        analyses.set(uri, cached);
      }
      return question(cached.analysis, document);
    } catch (error) {
      connection.console.error(
        `tea: compiler defect on ${uri}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      );
      return null;
    }
  }

  // A send rejects when the peer has hung up. The library logs that, and
  // nobody is left to tell.
  function send(params: PublishDiagnosticsParams): void {
    connection.sendDiagnostics(params).catch(() => {});
  }

  function publish(uri: string): void {
    const params = ask<PublishDiagnosticsParams>(uri, (analysis, document) => ({
      uri,
      version: document.version,
      diagnostics: [...analysis.diagnostics],
    }));
    // Null is a compiler defect: what was published before stays.
    if (params !== null) {
      send(params);
    }
  }

  connection.onInitialize(({capabilities}) => {
    registersFileWatcher =
      capabilities.workspace?.didChangeWatchedFiles?.dynamicRegistration ===
      true;
    return {
      capabilities: {
        textDocumentSync: {openClose: true, change: TextDocumentSyncKind.Full},
        hoverProvider: true,
        definitionProvider: true,
        referencesProvider: true,
        completionProvider: {triggerCharacters: ['.']},
        signatureHelpProvider: {triggerCharacters: ['(', ',']},
      },
    };
  });

  connection.onInitialized(() => {
    if (registersFileWatcher) {
      // A client that refuses loses nothing it asked for: the notification
      // is handled whether or not it was registered.
      connection.client
        .register(DidChangeWatchedFilesNotification.type, {
          watchers: [{globPattern: '**/*.tea'}],
        })
        .catch(() => {});
    }
  });

  // Fires on open and on every change.
  documents.onDidChangeContent(({document: {uri}}) => {
    clearTimeout(debounces.get(uri));
    debounces.set(
      uri,
      setTimeout(() => {
        debounces.delete(uri);
        // The host may have disposed the connection while this waited.
        // Sending then throws, outside any handler the library guards.
        try {
          publish(uri);
        } catch {}
      }, DEBOUNCE_MS),
    );
  });

  documents.onDidClose(({document: {uri}}) => {
    clearTimeout(debounces.get(uri));
    debounces.delete(uri);
    analyses.delete(uri);
    send({uri, diagnostics: []});
  });

  // A file on disk changed, and any open document may import it. Analysis
  // is cheap enough that no import graph is kept to find out which.
  connection.onDidChangeWatchedFiles(() => {
    analyses.clear();
    documents.all().forEach(document => publish(document.uri));
  });

  connection.onHover(({textDocument, position}) =>
    ask(textDocument.uri, analysis => hover(analysis, position)),
  );
  connection.onDefinition(({textDocument: {uri}, position}) =>
    ask(uri, analysis =>
      definition(analysis, position).map(({filename, range}) => ({
        uri: filename === filenameOf(uri) ? uri : uriOf(filename),
        range,
      })),
    ),
  );
  connection.onReferences(({textDocument: {uri}, position, context}) =>
    ask(uri, analysis =>
      references(analysis, position, context.includeDeclaration).map(range => ({
        uri,
        range,
      })),
    ),
  );
  connection.onCompletion(({textDocument, position}) =>
    ask(textDocument.uri, (analysis, document) =>
      completion(analysis, document.getText(), position),
    ),
  );
  connection.onSignatureHelp(({textDocument, position}) =>
    ask(textDocument.uri, (analysis, document) =>
      signatureHelp(analysis, document.getText(), position),
    ),
  );
  connection.onRequest('tea/libraryText', ({uri}: {uri: string}) =>
    libraryText(uri),
  );

  documents.listen(connection);
  connection.listen();
}

// The filename a document is analyzed under.
function filenameOf(uri: string): string {
  return uri.startsWith('file:') ? fileURLToPath(uri) : uri;
}

// The URI of a source file other than the document itself.
function uriOf(filename: string): string {
  return filename.startsWith(LIBRARY_DIR)
    ? LIBRARY_SCHEME + filename.slice(LIBRARY_DIR.length)
    : pathToFileURL(filename).href;
}

// The registry is keyed by import path, and a shipped library's file is its
// import path plus `.tea`; the round trip through `uriOf` checks that.
function libraryText(uri: string): string | null {
  const library = defaultRegistry(
    uri.slice(LIBRARY_SCHEME.length, -'.tea'.length),
  );
  return library !== null &&
    library !== 'external' &&
    uriOf(library.filename) === uri
    ? library.source
    : null;
}
