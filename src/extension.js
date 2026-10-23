// @ts-check
'use strict';

const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { diffLines } = require('./diff');
const store = require('./store');

const SCHEME = 'agent-review';
const BASELINES_KEY = 'agentReview.baselines';
const ONBOARDED_KEY = 'agentReview.onboarded';
const CONNECT_OFFERED_KEY = 'agentReview.connectOffered';
const HOOK_MATCHER = 'Edit|Write|MultiEdit|mcp__agent-harness__harness_replace|mcp__agent-harness__harness_write';
const STALE_MS = 10 * 60 * 1000;

const HELP = [
  'Cuando el agente cambia un archivo se abre una comparación: en rojo lo que había, en verde lo nuevo.',
  '',
  'Debajo de cada cambio aparece un recuadro con botones:',
  '  ✓ conserva ese bloque · ✗ lo deshace y vuelve al texto anterior.',
  '  ✓✓ y ⟲ aceptan o rechazan todo el archivo · ↑ ↓ saltan entre bloques.',
  '',
  'Atajos: Ctrl+Alt+Y acepta, Ctrl+Alt+N rechaza, Ctrl+Alt+] y Ctrl+Alt+[ saltan entre bloques.',
  '',
  'Cuando no quedan bloques, el archivo se guarda y la comparación se cierra sola.',
  'Si cierras la pestaña antes, la revisión queda pausada: retómala desde el escudo de la barra inferior.',
  'Desde ese mismo escudo puedes desactivar la revisión; entonces el agente aplica los cambios sin preguntar.',
].join('\n');

/**
 * @typedef {import('./store').ProposalInfo & {
 *   state: 'queued' | 'waiting' | 'active' | 'conflict' | 'paused' | 'error',
 *   message?: string,
 * }} Proposal
 * @typedef {import('./diff').Hunk} Hunk
 * @typedef {{
 *   proposal: Proposal,
 *   uri: vscode.Uri,
 *   original: string[],
 *   baseline: string[],
 *   version: number,
 *   hunks: Hunk[],
 *   rejected: boolean,
 *   shown: boolean,
 * }} Review
 */

class AgentReview {
  /** @param {vscode.ExtensionContext} context */
  constructor(context) {
    this.context = context;
    /** @type {Map<string, Proposal>} */
    this.proposals = new Map();
    /** @type {Map<string, Review>} */
    this.reviews = new Map();
    /** @type {Set<string>} */
    this.busy = new Set();
    /** @type {Set<string>} */
    this.finishing = new Set();
    this.roots = /** @type {string[]} */ ([]);
    this.polling = false;
    this.timer = /** @type {NodeJS.Timeout | undefined} */ (undefined);

    this.lensChanged = new vscode.EventEmitter();
    this.contentChanged = new vscode.EventEmitter();

    this.added = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
      borderWidth: '0 0 0 3px',
      borderStyle: 'solid',
      borderColor: new vscode.ThemeColor('editorGutter.addedBackground'),
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
    this.removed = vscode.window.createTextEditorDecorationType({
      after: {
        color: new vscode.ThemeColor('gitDecoration.deletedResourceForeground'),
        fontStyle: 'italic',
        margin: '0 0 0 2em',
      },
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });

    this.pending = vscode.window.createTextEditorDecorationType({
      gutterIconPath: vscode.Uri.joinPath(context.extensionUri, 'media', 'pending.svg'),
      gutterIconSize: '75%',
      overviewRulerColor: '#3794ff',
      overviewRulerLane: vscode.OverviewRulerLane.Right,
    });

    this.comments = vscode.comments.createCommentController('agentReview', 'Agent Review');
    /** @type {Map<string, vscode.CommentThread[]>} */
    this.threads = new Map();
    /** @type {WeakMap<vscode.CommentThread, { uri: string, index: number, version: number }>} */
    this.threadInfo = new WeakMap();

    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.status.show();

    context.subscriptions.push(
      this.added,
      this.removed,
      this.pending,
      this.status,
      this.comments,
      this.lensChanged,
      this.contentChanged,
      vscode.languages.registerCodeLensProvider(
        { scheme: 'file' },
        {
          onDidChangeCodeLenses: this.lensChanged.event,
          provideCodeLenses: (document) => this.codeLenses(document),
        },
      ),
      vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
        onDidChange: this.contentChanged.event,
        provideTextDocumentContent: (uri) => this.virtualContent(uri),
      }),
      vscode.workspace.onDidChangeTextDocument((event) => this.onDocumentChanged(event.document)),
      vscode.workspace.onDidCloseTextDocument((document) => this.onDocumentClosed(document)),
      vscode.window.onDidChangeVisibleTextEditors(() => this.decorateAll()),
      vscode.window.tabGroups.onDidChangeTabs((event) => this.onTabsClosed(event.closed)),
      vscode.window.onDidChangeActiveTextEditor(() => this.updateContext()),
      vscode.window.onDidChangeTextEditorSelection(() => this.updateContext()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration('agentReview')) return;
        this.schedule();
        this.refreshUi();
      }),
      {
        dispose: () => {
          if (this.timer) clearInterval(this.timer);
          store.clearHeartbeat();
        },
      },
    );

    const commands = {
      'agentReview.acceptHunk': (/** @type {any[]} */ ...args) => this.resolveHunk(true, ...args),
      'agentReview.rejectHunk': (/** @type {any[]} */ ...args) => this.resolveHunk(false, ...args),
      'agentReview.acceptAll': (/** @type {any} */ target) => this.resolveAll(true, target),
      'agentReview.rejectAll': (/** @type {any} */ target) => this.resolveAll(false, target),
      'agentReview.nextHunk': () => this.moveToHunk(1),
      'agentReview.previousHunk': () => this.moveToHunk(-1),
      'agentReview.openNext': () => this.openNext(),
      'agentReview.open': (/** @type {string} */ id) => this.open(id),
      'agentReview.showDiff': (/** @type {any} */ target) => this.showDiff(target),
      'agentReview.dismiss': (/** @type {any} */ target) => this.dismiss(target),
      'agentReview.refresh': () => this.poll(),
      'agentReview.toggle': () => this.setEnabled(!this.enabled()),
      'agentReview.enable': () => this.setEnabled(true),
      'agentReview.disable': () => this.setEnabled(false),
      'agentReview.menu': () => this.menu(),
      'agentReview.help': () => this.help(),
      'agentReview.connectClaude': () => this.connectClaude(),
      'agentReview.disconnectClaude': () => this.disconnectClaude(),
      'agentReview.connectCodex': () => this.connectCodex(),
      'agentReview.disconnectCodex': () => this.disconnectCodex(),
      'agentReview.thread.accept': (/** @type {any} */ thread) => this.threadAction(thread, 'accept'),
      'agentReview.thread.reject': (/** @type {any} */ thread) => this.threadAction(thread, 'reject'),
      'agentReview.thread.acceptAll': (/** @type {any} */ thread) => this.threadAction(thread, 'acceptAll'),
      'agentReview.thread.rejectAll': (/** @type {any} */ thread) => this.threadAction(thread, 'rejectAll'),
      'agentReview.thread.previous': (/** @type {any} */ thread) => this.threadAction(thread, 'previous'),
      'agentReview.thread.next': (/** @type {any} */ thread) => this.threadAction(thread, 'next'),
    };
    for (const [id, handler] of Object.entries(commands)) {
      context.subscriptions.push(vscode.commands.registerCommand(id, handler));
    }

    this.schedule();
    this.refreshUi();
    this.syncHook();
    this.offerConnect();
  }

  config() {
    return vscode.workspace.getConfiguration('agentReview');
  }

  enabled() {
    return this.config().get('enabled', true);
  }

  /** @param {boolean} value */
  async setEnabled(value) {
    await this.config().update('enabled', value, vscode.ConfigurationTarget.Global);
    vscode.window.setStatusBarMessage(
      value ? '$(shield) Agent Review activado: cada cambio del agente pasará por tu revisión' : '$(circle-slash) Agent Review desactivado',
      4000,
    );
  }

  resolveRoots() {
    const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    this.roots = store.discoverRoots(this.config().get('roots', []), folders);
  }

  schedule() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (!this.enabled()) {
      store.clearHeartbeat();
      this.suspend();
      return;
    }
    this.heartbeat();
    const interval = Math.max(500, this.config().get('pollIntervalMs', 1500));
    this.timer = setInterval(() => this.poll(), interval);
    this.poll();
  }

  heartbeat() {
    store.touchHeartbeat((vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath));
  }

  suspend() {
    for (const proposal of this.proposals.values()) {
      if (proposal.mode === 'applied') {
        store.removeRecord(proposal.recordPath);
        this.saveBaseline(proposal.id, undefined);
      }
    }
    this.proposals.clear();
    this.reviews.clear();
  }

  async poll() {
    if (this.polling || !this.enabled()) return;
    this.heartbeat();
    this.polling = true;
    try {
      this.resolveRoots();
      const seen = new Set();
      for (const source of store.sources(this.roots)) {
        for (const entry of store.listRecords(source.dir)) {
          seen.add(entry.recordPath);
          const known = [...this.proposals.values()].find((p) => p.recordPath === entry.recordPath);
          if (known && known.mtimeMs === entry.mtimeMs && known.size === entry.size) continue;
          let info;
          try {
            info = store.loadInfo(source, entry.recordPath, entry.mtimeMs, entry.size);
          } catch {
            continue;
          }
          if (info.status !== 'pending') {
            if (known) this.forget(known.id);
            continue;
          }
          if (known) {
            known.mtimeMs = info.mtimeMs;
            known.size = info.size;
            continue;
          }
          if (info.mode === 'applied' && !vscode.workspace.getWorkspaceFolder(vscode.Uri.file(info.absPath))) continue;
          /** @type {Proposal} */
          const proposal = { ...info, state: 'queued' };
          this.proposals.set(proposal.id, proposal);
        }
      }
      for (const proposal of [...this.proposals.values()]) {
        if (!seen.has(proposal.recordPath)) this.forget(proposal.id);
      }
      await this.activateQueued();
    } finally {
      this.polling = false;
      this.refreshUi();
    }
  }

  /** @param {string} id */
  forget(id) {
    const proposal = this.proposals.get(id);
    if (!proposal) return;
    this.proposals.delete(id);
    const review = this.reviewFor(proposal);
    if (review) this.reviews.delete(review.uri.toString());
    this.saveBaseline(id, undefined);
  }

  async activateQueued() {
    for (const proposal of this.sortedProposals()) {
      if (proposal.state === 'queued' || proposal.state === 'waiting') await this.activate(proposal, false);
    }
  }

  /**
   * @param {Proposal} proposal
   * @param {boolean} explicit
   */
  async activate(proposal, explicit) {
    const uri = vscode.Uri.file(proposal.absPath);
    const key = uri.toString();
    const current = this.reviews.get(key);
    if (current && current.proposal.id !== proposal.id) {
      return this.mark(proposal, 'queued', 'En espera: hay otra revisión abierta en este archivo');
    }
    if (current || this.busy.has(key) || this.finishing.has(key)) return;
    this.busy.add(key);
    try {
      const record = store.readRecord(proposal.recordPath);
      const originalText = store.stripBom(record.original);
      const original = store.splitLines(originalText);
      const saved = this.savedBaseline(proposal.id);
      let document;
      let baseline = original;
      if (proposal.mode === 'applied') {
        const onDisk = store.readText(proposal.absPath);
        if (onDisk === undefined || onDisk === originalText) {
          if (Date.now() - Date.parse(proposal.createdAt) > STALE_MS) {
            store.removeRecord(proposal.recordPath);
            this.forget(proposal.id);
            return;
          }
          return this.mark(proposal, 'waiting', 'Esperando el cambio del agente');
        }
        document = await vscode.workspace.openTextDocument(uri);
        if (saved !== undefined) baseline = store.splitLines(saved);
        else this.saveBaseline(proposal.id, originalText);
      } else {
        const candidate = store.splitLines(store.stripBom(record.candidate));
        document = await vscode.workspace.openTextDocument(uri);
        if (saved !== undefined && document.isDirty) {
          baseline = store.splitLines(saved);
        } else {
          if (document.isDirty) return this.mark(proposal, 'conflict', 'El archivo tiene cambios sin guardar');
          if (store.fileHash(proposal.absPath) !== proposal.baseHash) {
            return this.mark(proposal, 'conflict', 'El archivo cambió después de preparar la propuesta');
          }
          const edit = new vscode.WorkspaceEdit();
          edit.replace(uri, this.fullRange(document), candidate.join(this.eol(document)));
          if (!(await vscode.workspace.applyEdit(edit))) {
            return this.mark(proposal, 'error', 'No se pudo aplicar la propuesta al editor');
          }
          this.saveBaseline(proposal.id, originalText);
        }
      }
      proposal.state = 'active';
      proposal.message = undefined;
      /** @type {Review} */
      const review = { proposal, uri, original, baseline, version: -1, hunks: [], rejected: false, shown: false };
      this.reviews.set(key, review);
      if (this.hunks(review, document).length === 0) return this.finish(review, document);
      const reviewing = [...this.reviews.values()].some((r) => r !== review && r.shown);
      if (explicit || (this.config().get('autoOpen', true) && !reviewing)) {
        review.shown = true;
        await this.show(review, document, !explicit);
        this.onboard();
      } else if (!this.config().get('autoOpen', true)) {
        vscode.window
          .showInformationMessage(`El agente cambió ${path.basename(proposal.absPath)}`, 'Revisar')
          .then((choice) => choice && this.open(proposal.id));
      }
    } catch (error) {
      this.mark(proposal, 'error', error instanceof Error ? error.message : String(error));
    } finally {
      this.busy.delete(key);
      this.refreshUi();
    }
  }

  onboard() {
    if (this.context.globalState.get(ONBOARDED_KEY)) return;
    this.context.globalState.update(ONBOARDED_KEY, true);
    vscode.window
      .showInformationMessage(
        'Agent Review: revisa cada cambio del agente. ✓ Aceptar lo conserva, ✗ Rechazar lo deshace. Al terminar se guarda solo.',
        'Cómo funciona',
      )
      .then((choice) => choice && this.help());
  }

  help() {
    vscode.window.showInformationMessage('Cómo usar Agent Review', { modal: true, detail: HELP });
  }

  hookPaths() {
    const home = os.homedir();
    const hook = path.join(home, '.agent-review', 'snapshot.js');
    return {
      bundled: path.join(this.context.extensionPath, 'hooks', 'snapshot.js'),
      hook,
      settings: path.join(home, '.claude', 'settings.json'),
      command: `node "${hook.replace(/\\/g, '/')}"`,
    };
  }

  codexHookPaths() {
    const home = os.homedir();
    const hook = path.join(home, '.agent-review', 'codex.js');
    return {
      bundled: path.join(this.context.extensionPath, 'hooks', 'codex.js'),
      hook,
      settings: path.join(home, '.codex', 'hooks.json'),
      command: `node "${hook.replace(/\\/g, '/')}"`,
      commandWindows: `node "${hook}"`,
    };
  }

  isOurCodexHook(entry) {
    return (entry?.hooks ?? []).some(
      (/** @type {any} */ h) => typeof h.command === 'string' && /\.agent-review[\\/]codex\.js/i.test(h.command),
    );
  }

  readCodexSettings() {
    const { settings } = this.codexHookPaths();
    if (!fs.existsSync(settings)) return {};
    return JSON.parse(fs.readFileSync(settings, 'utf8'));
  }

  codexConnected() {
    try {
      return (this.readCodexSettings().hooks?.PreToolUse ?? []).some((/** @type {any} */ e) => this.isOurCodexHook(e));
    } catch {
      return false;
    }
  }

  /** @param {any} entry */
  isOurHook(entry) {
    return (entry?.hooks ?? []).some(
      (/** @type {any} */ h) =>
        typeof h.command === 'string' && /(\.agent-review|extensions\/vscode\/hooks)\/snapshot\.js/.test(h.command.replace(/\\/g, '/')),
    );
  }

  readClaudeSettings() {
    const { settings } = this.hookPaths();
    if (!fs.existsSync(settings)) return {};
    return JSON.parse(fs.readFileSync(settings, 'utf8'));
  }

  connected() {
    try {
      return (this.readClaudeSettings().hooks?.PreToolUse ?? []).some((/** @type {any} */ e) => this.isOurHook(e));
    } catch {
      return false;
    }
  }

  syncHook() {
    const { bundled, hook } = this.hookPaths();
    try {
      if (fs.existsSync(hook) && fs.readFileSync(hook, 'utf8') !== fs.readFileSync(bundled, 'utf8')) {
        fs.copyFileSync(bundled, hook);
      }
    } catch {}
    if (this.codexConnected()) {
      const codex = this.codexHookPaths();
      try {
        if (fs.existsSync(codex.hook) && fs.readFileSync(codex.hook, 'utf8') !== fs.readFileSync(codex.bundled, 'utf8')) {
          fs.copyFileSync(codex.bundled, codex.hook);
        }
      } catch {}
    }
  }

  offerConnect() {
    if (this.context.globalState.get(CONNECT_OFFERED_KEY) || this.connected() || this.codexConnected()) return;
    this.context.globalState.update(CONNECT_OFFERED_KEY, true);
    vscode.window
      .showInformationMessage(
        'Agent Review: conéctalo a Claude Code o Codex para revisar aquí cada cambio del agente.',
        'Conectar Claude Code',
        'Conectar Codex',
        'Ahora no',
      )
      .then((choice) => {
        if (choice === 'Conectar Claude Code') return this.connectClaude();
        if (choice === 'Conectar Codex') return this.connectCodex();
      });
  }

  async connectCodex() {
    const paths = this.codexHookPaths();
    const choice = await vscode.window.showInformationMessage(
      'Conectar Agent Review con Codex',
      {
        modal: true,
        detail: [
          `Se copiará el hook a:\n${paths.hook}`,
          `y se agregará a:\n${paths.settings}`,
          '(antes se guarda una copia de respaldo con extensión .agent-review.bak).',
          '',
          'Agent Review registrará los archivos de las llamadas apply_patch de Codex y luego los revisará en VS Code.',
          'Codex pedirá que confíes el hook. Reinicia Codex después de conectarlo.',
          'Requiere Node.js instalado.',
        ].join('\n'),
      },
      'Conectar',
    );
    if (!choice) return;

    let settings;
    try {
      settings = this.readCodexSettings();
    } catch {
      vscode.window.showErrorMessage(`No pude leer ${paths.settings} (no es JSON válido). Agrega el hook a mano siguiendo INSTALAR.md.`);
      return;
    }
    try {
      fs.mkdirSync(path.dirname(paths.hook), { recursive: true });
      fs.copyFileSync(paths.bundled, paths.hook);
      fs.mkdirSync(path.dirname(paths.settings), { recursive: true });
      if (fs.existsSync(paths.settings)) fs.copyFileSync(paths.settings, `${paths.settings}.agent-review.bak`);
      settings.hooks ??= {};
      settings.hooks.PreToolUse ??= [];
      if (!Array.isArray(settings.hooks.PreToolUse)) throw new Error('hooks.PreToolUse debe ser una lista en hooks.json');
      if (!settings.hooks.PreToolUse.some((/** @type {any} */ e) => this.isOurCodexHook(e))) {
        settings.hooks.PreToolUse.push({
          matcher: '^apply_patch$',
          hooks: [{ type: 'command', command: paths.command, commandWindows: paths.commandWindows, timeout: 10 }],
        });
      }
      fs.writeFileSync(paths.settings, `${JSON.stringify(settings, null, 2)}\n`);
    } catch (error) {
      vscode.window.showErrorMessage(`No se pudo conectar Codex: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    vscode.window.showInformationMessage('Agent Review conectado con Codex. Reinícialo y confía el hook cuando lo solicite.');
  }

  async disconnectCodex() {
    const paths = this.codexHookPaths();
    try {
      const settings = this.readCodexSettings();
      const entries = settings.hooks?.PreToolUse ?? [];
      let removed = false;
      const kept = entries.map((/** @type {any} */ entry) => {
        const hooks = entry.hooks ?? [];
        const remaining = hooks.filter((/** @type {any} */ hook) => {
          const ours = typeof hook.command === 'string' && /\.agent-review[\\/]codex\.js/i.test(hook.command);
          removed ||= ours;
          return !ours;
        });
        return { ...entry, hooks: remaining };
      }).filter((/** @type {any} */ entry) => entry.hooks.length > 0);
      if (!removed) {
        vscode.window.showInformationMessage('Agent Review no estaba conectado con Codex.');
        return;
      }
      fs.copyFileSync(paths.settings, `${paths.settings}.agent-review.bak`);
      if (kept.length > 0) settings.hooks.PreToolUse = kept;
      else delete settings.hooks.PreToolUse;
      if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;
      fs.writeFileSync(paths.settings, `${JSON.stringify(settings, null, 2)}\n`);
      vscode.window.showInformationMessage('Agent Review desconectado de Codex. Reinicia Codex para cargar la configuración.');
    } catch (error) {
      vscode.window.showErrorMessage(`No se pudo desconectar Codex: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async connectClaude() {
    const paths = this.hookPaths();
    const choice = await vscode.window.showInformationMessage(
      'Conectar Agent Review con Claude Code',
      {
        modal: true,
        detail: [
          `Se copiará el hook a:\n${paths.hook}`,
          `y se agregará a:\n${paths.settings}`,
          '(antes se guarda una copia de respaldo con extensión .agent-review.bak).',
          '',
          'Con la revisión activa, Claude Code no pedirá permiso para editar archivos de tu workspace: los revisas aquí, bloque por bloque.',
          'Requiere Node.js instalado.',
        ].join('\n'),
      },
      'Conectar',
    );
    if (!choice) return;
    let settings;
    try {
      settings = this.readClaudeSettings();
    } catch {
      vscode.window.showErrorMessage(
        `No pude leer ${paths.settings} (no es JSON válido). Agrega el hook a mano siguiendo INSTALAR.md.`,
      );
      return;
    }
    try {
      fs.mkdirSync(path.dirname(paths.hook), { recursive: true });
      fs.copyFileSync(paths.bundled, paths.hook);
      fs.mkdirSync(path.dirname(paths.settings), { recursive: true });
      if (fs.existsSync(paths.settings)) fs.copyFileSync(paths.settings, `${paths.settings}.agent-review.bak`);
      settings.hooks ??= {};
      settings.hooks.PreToolUse ??= [];
      if (!settings.hooks.PreToolUse.some((/** @type {any} */ e) => this.isOurHook(e))) {
        settings.hooks.PreToolUse.push({
          matcher: HOOK_MATCHER,
          hooks: [{ type: 'command', command: paths.command, timeout: 10 }],
        });
      }
      fs.writeFileSync(paths.settings, `${JSON.stringify(settings, null, 2)}\n`);
    } catch (error) {
      vscode.window.showErrorMessage(`No se pudo conectar: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    vscode.window.showInformationMessage(
      'Agent Review conectado. En Claude Code abre /hooks una vez (o reinicia la sesión) para que lo cargue.',
    );
  }

  async disconnectClaude() {
    const paths = this.hookPaths();
    try {
      const settings = this.readClaudeSettings();
      const entries = settings.hooks?.PreToolUse ?? [];
      const kept = entries.filter((/** @type {any} */ e) => !this.isOurHook(e));
      if (kept.length === entries.length) {
        vscode.window.showInformationMessage('Agent Review no estaba conectado a Claude Code.');
        return;
      }
      fs.copyFileSync(paths.settings, `${paths.settings}.agent-review.bak`);
      if (kept.length > 0) settings.hooks.PreToolUse = kept;
      else delete settings.hooks.PreToolUse;
      if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;
      fs.writeFileSync(paths.settings, `${JSON.stringify(settings, null, 2)}\n`);
      vscode.window.showInformationMessage('Agent Review desconectado de Claude Code. Abre /hooks o reinicia la sesión.');
    } catch (error) {
      vscode.window.showErrorMessage(`No se pudo desconectar: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * @param {Proposal} proposal
   * @param {Proposal['state']} state
   * @param {string} message
   */
  mark(proposal, state, message) {
    proposal.state = state;
    proposal.message = message;
  }

  /**
   * @param {Review} review
   * @param {vscode.TextDocument} document
   */
  hunks(review, document) {
    if (review.version !== document.version) {
      const ignore = vscode.workspace.getConfiguration('diffEditor').get('ignoreTrimWhitespace', true);
      const key = ignore ? (/** @type {string} */ line) => line.trim() : (/** @type {string} */ line) => line;
      review.hunks = diffLines(review.baseline.map(key), store.splitLines(document.getText()).map(key));
      review.version = document.version;
    }
    return review.hunks;
  }

  /** @param {vscode.TextDocument} document */
  onDocumentChanged(document) {
    const review = this.reviews.get(document.uri.toString());
    if (!review) return;
    this.hunks(review, document);
    this.refreshUi();
    if (review.hunks.length === 0) this.finish(review, document);
  }

  /** @param {vscode.TextDocument} document */
  onDocumentClosed(document) {
    const review = this.reviews.get(document.uri.toString());
    if (!review) return;
    this.reviews.delete(document.uri.toString());
    if (review.proposal.mode === 'deferred') this.saveBaseline(review.proposal.id, undefined);
    this.mark(review.proposal, 'paused', 'Pausada: se cerró el archivo sin terminar');
    this.refreshUi();
  }

  /**
   * @param {boolean} accept
   * @param {any[]} args
   */
  async resolveHunk(accept, ...args) {
    const [uriText, index, version] = args;
    const editor = uriText
      ? vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uriText)
      : vscode.window.activeTextEditor;
    const document = editor?.document ?? (uriText ? await vscode.workspace.openTextDocument(vscode.Uri.parse(uriText)) : undefined);
    if (!document) return;
    const review = this.reviews.get(document.uri.toString());
    if (!review) return;
    const hunks = this.hunks(review, document);
    let hunk;
    if (typeof index === 'number') {
      if (version !== document.version) return this.refreshUi();
      hunk = hunks[index];
    } else if (editor) {
      hunk = this.hunkAt(review, document, editor.selection.active.line);
    }
    if (!hunk) return;
    if (accept) {
      const current = store.splitLines(document.getText());
      review.baseline = [
        ...review.baseline.slice(0, hunk.oldStart),
        ...current.slice(hunk.newStart, hunk.newStart + hunk.newLines),
        ...review.baseline.slice(hunk.oldStart + hunk.oldLines),
      ];
      review.version = -1;
      this.saveBaseline(review.proposal.id, review.baseline.join('\n'));
      this.onDocumentChanged(document);
    } else {
      review.rejected = true;
      const replacement = review.baseline.slice(hunk.oldStart, hunk.oldStart + hunk.oldLines);
      await this.replaceLines(document, hunk.newStart, hunk.newStart + hunk.newLines, replacement);
    }
    if (editor && this.reviews.has(document.uri.toString())) {
      const next = this.hunks(review, document).find((h) => h.newStart >= hunk.newStart);
      if (next) this.reveal(editor, next);
    }
  }

  /**
   * @param {boolean} accept
   * @param {any} target
   */
  async resolveAll(accept, target) {
    const review = this.reviewFromTarget(target);
    if (!review) return;
    const document = await vscode.workspace.openTextDocument(review.uri);
    if (accept) {
      review.baseline = store.splitLines(document.getText());
      review.version = -1;
      this.onDocumentChanged(document);
      return;
    }
    review.rejected = true;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(review.uri, this.fullRange(document), review.baseline.join(this.eol(document)));
    await vscode.workspace.applyEdit(edit);
    this.onDocumentChanged(document);
  }

  /**
   * @param {vscode.TextDocument} document
   * @param {number} start
   * @param {number} end
   * @param {string[]} lines
   */
  async replaceLines(document, start, end, lines) {
    const eol = this.eol(document);
    const count = document.lineCount;
    const last = document.lineAt(count - 1).range.end;
    let range;
    let text;
    if (start >= count) {
      range = new vscode.Range(last, last);
      text = lines.map((line) => eol + line).join('');
    } else if (end < count) {
      range = new vscode.Range(start, 0, end, 0);
      text = lines.map((line) => line + eol).join('');
    } else if (lines.length > 0 || start === 0) {
      range = new vscode.Range(new vscode.Position(start, 0), last);
      text = lines.join(eol);
    } else {
      range = new vscode.Range(document.lineAt(start - 1).range.end, last);
      text = '';
    }
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, range, text);
    await vscode.workspace.applyEdit(edit);
  }

  /**
   * @param {Review} review
   * @param {vscode.TextDocument} document
   */
  async finish(review, document) {
    const key = review.uri.toString();
    if (this.finishing.has(key)) return;
    this.finishing.add(key);
    const proposal = review.proposal;
    try {
      const result = review.baseline.join('\n');
      const outcome = result === review.original.join('\n') ? 'rejected' : review.rejected ? 'partial' : 'accepted';
      if (document.isDirty && this.config().get('saveOnResolve', true)) await document.save();
      this.reviews.delete(key);
      if (!document.isDirty) await this.closeDiffTabs(key);
      if (proposal.created && outcome === 'rejected' && !document.isDirty) {
        await vscode.workspace.fs.delete(review.uri, { useTrash: true });
      }
      if (proposal.mode === 'applied') {
        store.removeRecord(proposal.recordPath);
      } else {
        store.updateRecord(proposal.recordPath, {
          status: outcome,
          resolvedAt: new Date().toISOString(),
          resolvedBy: 'agent-review-vscode',
          resultHash: document.isDirty ? null : store.fileHash(proposal.absPath),
        });
      }
      this.proposals.delete(proposal.id);
      this.saveBaseline(proposal.id, undefined);
      const labels = {
        accepted: '$(check) Cambios aceptados',
        rejected: '$(discard) Cambios rechazados',
        partial: '$(check) Cambios aceptados en parte',
      };
      vscode.window.setStatusBarMessage(`${labels[outcome]} en ${path.basename(proposal.absPath)}`, 5000);
    } catch (error) {
      this.mark(proposal, 'error', error instanceof Error ? error.message : String(error));
    } finally {
      this.finishing.delete(key);
      await this.activateQueued();
      await this.showNextPending();
      this.refreshUi();
    }
  }

  /** @param {string} uri */
  async closeDiffTabs(uri) {
    const tabs = vscode.window.tabGroups.all.flatMap((group) =>
      group.tabs.filter(
        (tab) =>
          tab.input instanceof vscode.TabInputTextDiff &&
          tab.input.original.scheme === SCHEME &&
          tab.input.modified.toString() === uri,
      ),
    );
    if (tabs.length > 0) await vscode.window.tabGroups.close(tabs);
  }

  /** @param {any} target */
  async dismiss(target) {
    const proposal = this.proposalFromTarget(target);
    if (!proposal) return;
    const detail =
      proposal.mode === 'applied'
        ? 'Los cambios del agente se quedan tal como están.'
        : 'El archivo no se modifica.';
    const choice = await vscode.window.showWarningMessage(
      `¿Quitar ${this.display(proposal)} de la revisión?`,
      { modal: true, detail },
      'Quitar',
    );
    if (!choice) return;
    if (proposal.mode === 'applied') {
      store.removeRecord(proposal.recordPath);
    } else {
      store.updateRecord(proposal.recordPath, {
        status: 'dismissed',
        resolvedAt: new Date().toISOString(),
        resolvedBy: 'agent-review-vscode',
      });
    }
    const review = this.reviewFor(proposal);
    this.forget(proposal.id);
    if (review) await this.closeDiffTabs(review.uri.toString());
    await this.activateQueued();
    await this.showNextPending();
    this.refreshUi();
  }

  /** @param {any} target */
  async showDiff(target) {
    const proposal = this.proposalFromTarget(target) ?? this.reviewFromTarget(target)?.proposal;
    if (!proposal) return;
    const name = path.basename(proposal.absPath);
    const left =
      proposal.state === 'conflict'
        ? vscode.Uri.file(proposal.absPath)
        : vscode.Uri.from({ scheme: SCHEME, path: `/${proposal.id}/${name}`, query: 'original' });
    const right = vscode.Uri.from({ scheme: SCHEME, path: `/${proposal.id}/${name}`, query: 'candidate' });
    const title = proposal.state === 'conflict' ? `${name} (actual ↔ propuesta)` : `${name} (original ↔ propuesta)`;
    await vscode.commands.executeCommand('vscode.diff', left, right, title);
  }

  /** @param {vscode.Uri} uri */
  virtualContent(uri) {
    const id = uri.path.split('/')[1];
    const proposal = this.proposals.get(id);
    if (!proposal) return '';
    if (uri.query === 'baseline') return this.reviewFor(proposal)?.baseline.join('\n') ?? '';
    const record = store.readRecord(proposal.recordPath);
    if (uri.query === 'original') return store.stripBom(record.original);
    return proposal.mode === 'applied' ? store.readText(proposal.absPath) ?? '' : store.stripBom(record.candidate);
  }

  /** @param {string} id */
  async open(id) {
    const proposal = this.proposals.get(id);
    if (!proposal) return;
    if (proposal.state === 'conflict' || proposal.state === 'error') return this.showDiff(proposal);
    const review = this.reviewFor(proposal);
    if (!review) return this.activate(proposal, true);
    review.shown = true;
    await this.show(review, await vscode.workspace.openTextDocument(review.uri), false);
  }

  async showNextPending() {
    if (!this.config().get('autoOpen', true)) return;
    if ([...this.reviews.values()].some((r) => r.shown)) return;
    const next = this.sortedProposals()
      .map((p) => this.reviewFor(p))
      .find((r) => r !== undefined);
    if (!next) return;
    next.shown = true;
    await this.show(next, await vscode.workspace.openTextDocument(next.uri), false);
  }

  /** @param {readonly vscode.Tab[]} closed */
  onTabsClosed(closed) {
    for (const tab of closed) {
      if (!(tab.input instanceof vscode.TabInputTextDiff) || tab.input.original.scheme !== SCHEME) continue;
      const review = this.reviews.get(tab.input.modified.toString());
      if (review) review.shown = false;
    }
  }

  async menu() {
    /** @type {(vscode.QuickPickItem & { id?: string, action?: string })[]} */
    const items = [];
    const pending = this.sortedProposals().filter((p) => p.state !== 'waiting');
    if (pending.length > 0) {
      items.push({ label: 'Por revisar', kind: vscode.QuickPickItemKind.Separator });
      for (const proposal of pending) {
        items.push({
          id: proposal.id,
          label: `$(diff) ${path.basename(proposal.absPath)}`,
          description: this.stateLabel(proposal),
          detail: `${path.posix.dirname(this.display(proposal))} · ${proposal.source}`,
          buttons: [{ iconPath: new vscode.ThemeIcon('trash'), tooltip: 'Quitar de la revisión' }],
        });
      }
    }
    items.push(
      { label: 'Agent Review', kind: vscode.QuickPickItemKind.Separator },
      this.enabled()
        ? { action: 'toggle', label: '$(circle-slash) Desactivar revisión', description: 'el agente aplicará los cambios sin preguntar' }
        : { action: 'toggle', label: '$(shield) Activar revisión', description: 'cada cambio del agente pasará por ti' },
      this.connected()
        ? { action: 'disconnect', label: '$(debug-disconnect) Desconectar de Claude Code' }
        : { action: 'connect', label: '$(plug) Conectar con Claude Code', description: 'necesario para revisar sus cambios' },
      this.codexConnected()
        ? { action: 'disconnectCodex', label: '$(debug-disconnect) Desconectar de Codex' }
        : { action: 'connectCodex', label: '$(plug) Conectar con Codex', description: 'revisar cambios de apply_patch' },
      { action: 'help', label: '$(question) Cómo funciona' },
    );
    const pick = vscode.window.createQuickPick();
    pick.items = items;
    pick.title = this.enabled() ? 'Agent Review · activo' : 'Agent Review · desactivado';
    pick.placeholder = pending.length ? 'Elige un archivo para revisarlo' : 'No hay cambios pendientes';
    pick.onDidTriggerItemButton(async (event) => {
      pick.hide();
      const id = /** @type {any} */ (event.item).id;
      if (id) await this.dismiss(this.proposals.get(id));
    });
    pick.onDidAccept(async () => {
      const item = /** @type {any} */ (pick.selectedItems[0]);
      pick.hide();
      if (!item) return;
      if (item.id) await this.open(item.id);
      else if (item.action === 'toggle') await this.setEnabled(!this.enabled());
      else if (item.action === 'help') this.help();
      else if (item.action === 'connect') await this.connectClaude();
      else if (item.action === 'disconnect') await this.disconnectClaude();
      else if (item.action === 'connectCodex') await this.connectCodex();
      else if (item.action === 'disconnectCodex') await this.disconnectCodex();
    });
    pick.onDidHide(() => pick.dispose());
    pick.show();
  }

  /**
   * @param {Review} review
   * @param {vscode.TextDocument} document
   * @param {boolean} preserveFocus
   */
  async show(review, document, preserveFocus) {
    let editor;
    if (this.config().get('viewMode', 'diff') === 'diff') {
      const title = `${path.basename(review.proposal.absPath)} · revisión del agente`;
      await vscode.commands.executeCommand('vscode.diff', this.baselineUri(review), review.uri, title, {
        preview: false,
        preserveFocus,
      });
      editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === review.uri.toString());
    } else {
      editor = await vscode.window.showTextDocument(document, { preview: false, preserveFocus });
    }
    if (editor) this.reveal(editor, this.hunks(review, document)[0]);
  }

  /** @param {Review} review */
  baselineUri(review) {
    return vscode.Uri.from({
      scheme: SCHEME,
      path: `/${review.proposal.id}/${path.basename(review.proposal.absPath)}`,
      query: 'baseline',
    });
  }

  /** @param {vscode.TextEditor} editor */
  inDiff(editor) {
    const uri = editor.document.uri.toString();
    return vscode.window.tabGroups.all.some((group) => {
      const input = group.activeTab?.input;
      return (
        group.viewColumn === editor.viewColumn &&
        input instanceof vscode.TabInputTextDiff &&
        input.original.scheme === SCHEME &&
        input.modified.toString() === uri
      );
    });
  }

  async openNext() {
    const editor = vscode.window.activeTextEditor;
    const active = editor && this.reviews.get(editor.document.uri.toString());
    if (active && this.hunks(active, editor.document).length > 0) return this.moveToHunk(1);
    const next = this.sortedProposals().find((p) => p.state !== 'waiting');
    if (next) await this.open(next.id);
  }

  /** @param {number} direction */
  moveToHunk(direction) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const review = this.reviews.get(editor.document.uri.toString());
    if (!review) return;
    const hunks = this.hunks(review, editor.document);
    if (hunks.length === 0) return;
    const line = editor.selection.active.line;
    const ordered = direction > 0 ? hunks : [...hunks].reverse();
    const target =
      ordered.find((h) => (direction > 0 ? this.anchor(h, editor.document) > line : this.anchor(h, editor.document) < line)) ??
      ordered[0];
    this.reveal(editor, target);
  }

  /**
   * @param {vscode.TextEditor} editor
   * @param {Hunk | undefined} hunk
   */
  reveal(editor, hunk) {
    if (!hunk) return;
    const line = this.anchor(hunk, editor.document);
    const position = new vscode.Position(line, 0);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  /**
   * @param {Hunk} hunk
   * @param {vscode.TextDocument} document
   */
  anchor(hunk, document) {
    return Math.min(hunk.newStart, document.lineCount - 1);
  }

  /**
   * @param {Hunk} hunk
   * @param {vscode.TextDocument} document
   */
  threadLine(hunk, document) {
    return hunk.newLines > 0 ? Math.min(hunk.newStart + hunk.newLines - 1, document.lineCount - 1) : this.anchor(hunk, document);
  }

  /**
   * @param {Review} review
   * @param {vscode.TextDocument} document
   * @param {number} line
   */
  hunkAt(review, document, line) {
    return this.hunks(review, document).find((h) => {
      const start = this.anchor(h, document);
      return line >= start && line < start + Math.max(h.newLines, 1);
    });
  }

  /** @param {vscode.TextDocument} document */
  codeLenses(document) {
    const review = this.reviews.get(document.uri.toString());
    if (!review) return [];
    const hunks = this.hunks(review, document);
    if (hunks.length === 0) return [];
    const top = new vscode.Range(0, 0, 0, 0);
    const lenses = [
      new vscode.CodeLens(top, {
        title: `$(shield) ${hunks.length} ${hunks.length === 1 ? 'cambio' : 'cambios'} del agente por revisar`,
        tooltip: 'Ir al siguiente bloque',
        command: 'agentReview.nextHunk',
      }),
      new vscode.CodeLens(top, { title: '$(question)', tooltip: 'Cómo funciona', command: 'agentReview.help' }),
    ];
    const others = this.sortedProposals().filter((p) => p.id !== review.proposal.id && p.state !== 'waiting').length;
    if (others > 0) {
      lenses.splice(
        1,
        0,
        new vscode.CodeLens(top, {
          title: `$(files) ${others} ${others === 1 ? 'archivo más' : 'archivos más'} en espera`,
          tooltip: 'Se abren solos al terminar este. Clic para ver la lista.',
          command: 'agentReview.menu',
        }),
      );
    }
    return lenses;
  }

  decorateAll() {
    for (const editor of vscode.window.visibleTextEditors) {
      const review = this.reviews.get(editor.document.uri.toString());
      if (!review) {
        editor.setDecorations(this.added, []);
        editor.setDecorations(this.removed, []);
        editor.setDecorations(this.pending, []);
        continue;
      }
      const document = editor.document;
      const hunks = this.hunks(review, document);
      editor.setDecorations(
        this.pending,
        hunks.map((hunk) => new vscode.Range(this.anchor(hunk, document), 0, this.anchor(hunk, document), 0)),
      );
      if (this.inDiff(editor)) {
        editor.setDecorations(this.added, []);
        editor.setDecorations(this.removed, []);
        continue;
      }
      const added = [];
      const removed = [];
      for (const hunk of hunks) {
        if (hunk.newLines > 0) {
          added.push(new vscode.Range(hunk.newStart, 0, hunk.newStart + hunk.newLines - 1, 0));
          continue;
        }
        removed.push({
          range: document.lineAt(this.anchor(hunk, document)).range,
          renderOptions: {
            after: {
              contentText: `− ${hunk.oldLines} ${hunk.oldLines === 1 ? 'línea eliminada' : 'líneas eliminadas'}`,
            },
          },
        });
      }
      editor.setDecorations(this.added, added);
      editor.setDecorations(this.removed, removed);
    }
  }

  syncThreads() {
    for (const [key, threads] of this.threads) {
      if (this.reviews.has(key)) continue;
      threads.forEach((thread) => thread.dispose());
      this.threads.delete(key);
    }
    for (const [key, review] of this.reviews) {
      const document = vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
      if (!document) continue;
      const hunks = this.hunks(review, document);
      const threads = this.threads.get(key) ?? [];
      hunks.forEach((hunk, index) => {
        const line = this.threadLine(hunk, document);
        let thread = threads[index];
        if (!thread) {
          thread = this.comments.createCommentThread(review.uri, new vscode.Range(line, 0, line, 0), []);
          thread.canReply = false;
          thread.contextValue = 'agentReviewHunk';
          thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
          threads.push(thread);
        } else if (thread.range?.start.line !== line) {
          thread.range = new vscode.Range(line, 0, line, 0);
        }
        const label = `${index + 1}/${hunks.length}`;
        if (thread.label !== label) thread.label = label;
        this.threadInfo.set(thread, { uri: key, index, version: document.version });
      });
      threads.splice(hunks.length).forEach((thread) => thread.dispose());
      this.threads.set(key, threads);
    }
  }

  /**
   * @param {any} thread
   * @param {'accept' | 'reject' | 'acceptAll' | 'rejectAll' | 'previous' | 'next'} action
   */
  async threadAction(thread, action) {
    const info = this.threadInfo.get(thread);
    if (!info) return;
    if (action === 'accept' || action === 'reject') {
      return this.resolveHunk(action === 'accept', info.uri, info.index, info.version);
    }
    if (action === 'acceptAll' || action === 'rejectAll') return this.resolveAll(action === 'acceptAll', info.uri);
    const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === info.uri);
    const review = this.reviews.get(info.uri);
    if (!editor || !review) return;
    const hunks = this.hunks(review, editor.document);
    if (hunks.length === 0) return;
    this.reveal(editor, hunks[(info.index + (action === 'next' ? 1 : -1) + hunks.length) % hunks.length]);
  }

  updateContext() {
    const editor = vscode.window.activeTextEditor;
    const review = editor && this.reviews.get(editor.document.uri.toString());
    const hasHunks = !!review && this.hunks(review, editor.document).length > 0;
    const inHunk = !!review && !!this.hunkAt(review, editor.document, editor.selection.active.line);
    vscode.commands.executeCommand('setContext', 'agentReview.fileHasHunks', hasHunks);
    vscode.commands.executeCommand('setContext', 'agentReview.cursorInHunk', inHunk);
  }

  refreshUi() {
    for (const review of this.reviews.values()) this.contentChanged.fire(this.baselineUri(review));
    this.decorateAll();
    this.updateContext();
    this.lensChanged.fire(undefined);
    const visible = [...this.proposals.values()].filter((p) => p.state !== 'waiting');
    const conflicts = visible.filter((p) => p.state === 'conflict' || p.state === 'error').length;
    const accent = this.config().get('accentColor', '#3794ff');
    if (!this.enabled()) {
      this.status.text = '$(circle-slash)';
      this.status.color = undefined;
      this.status.command = 'agentReview.toggle';
      this.status.tooltip = 'Agent Review desactivado: el agente aplica los cambios sin preguntar. Clic para activar.';
    } else if (visible.length === 0) {
      this.status.text = '$(shield)';
      this.status.color = accent;
      this.status.command = 'agentReview.toggle';
      this.status.tooltip = 'Agent Review activo: cada cambio del agente pasa por tu revisión. Clic para desactivar.';
    } else {
      this.status.text = `$(shield) ${visible.length}${conflicts ? ` $(warning) ${conflicts}` : ''}`;
      this.status.color = accent;
      this.status.command = 'agentReview.menu';
      this.status.tooltip = `${visible.length} archivo(s) con cambios del agente por revisar. Clic para ver la lista; ahí también puedes desactivar.`;
    }
    this.syncThreads();
  }

  sortedProposals() {
    return [...this.proposals.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** @param {Proposal} proposal */
  stateLabel(proposal) {
    const review = this.reviewFor(proposal);
    if (review) return `${review.hunks.length} ${review.hunks.length === 1 ? 'bloque' : 'bloques'} por revisar`;
    const states = {
      active: 'por revisar',
      queued: 'en espera',
      waiting: 'esperando cambio',
      paused: 'pausada · clic para retomar',
      conflict: 'conflicto · clic para ver el diff',
      error: 'error',
    };
    return proposal.message && proposal.state !== 'paused' ? proposal.message : states[proposal.state];
  }

  /** @param {Proposal} proposal */
  display(proposal) {
    return vscode.workspace.asRelativePath(proposal.absPath);
  }

  /** @param {Proposal} proposal */
  reviewFor(proposal) {
    return [...this.reviews.values()].find((r) => r.proposal.id === proposal.id);
  }

  /** @param {any} target */
  proposalFromTarget(target) {
    if (target && typeof target === 'object' && 'recordPath' in target) return this.proposals.get(target.id);
    return undefined;
  }

  /** @param {any} target */
  reviewFromTarget(target) {
    const proposal = this.proposalFromTarget(target);
    if (proposal) return this.reviewFor(proposal);
    const uri =
      typeof target === 'string' ? target : target instanceof vscode.Uri ? target.toString() : vscode.window.activeTextEditor?.document.uri.toString();
    return uri ? this.reviews.get(uri) : undefined;
  }

  /** @param {vscode.TextDocument} document */
  eol(document) {
    return document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  }

  /** @param {vscode.TextDocument} document */
  fullRange(document) {
    return new vscode.Range(new vscode.Position(0, 0), document.lineAt(document.lineCount - 1).range.end);
  }

  /** @param {string} id */
  savedBaseline(id) {
    return this.context.workspaceState.get(BASELINES_KEY, /** @type {Record<string, string>} */ ({}))[id];
  }

  /**
   * @param {string} id
   * @param {string | undefined} text
   */
  saveBaseline(id, text) {
    const all = { ...this.context.workspaceState.get(BASELINES_KEY, /** @type {Record<string, string>} */ ({})) };
    if (text === undefined) delete all[id];
    else all[id] = text;
    this.context.workspaceState.update(BASELINES_KEY, all);
  }
}

/** @param {vscode.ExtensionContext} context */
function activate(context) {
  new AgentReview(context);
}

function deactivate() {}

module.exports = { activate, deactivate };
