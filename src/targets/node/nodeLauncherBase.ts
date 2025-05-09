/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as dotenv from 'dotenv';
import * as fs from 'fs';
import { inject, injectable } from 'inversify';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { IPortLeaseTracker } from '../../adapter/portLeaseTracker';
import { getSourceSuffix } from '../../adapter/templates';
import Cdp from '../../cdp/api';
import Connection from '../../cdp/connection';
import { RawPipeTransport } from '../../cdp/rawPipeTransport';
import { WorkerTransport } from '../../cdp/workerTransport';
import { CancellationTokenSource, NeverCancelled } from '../../common/cancellation';
import { AutoAttachMode } from '../../common/contributionUtils';
import { ObservableMap } from '../../common/datastructure/observableMap';
import { DisposableList } from '../../common/disposable';
import { EnvironmentVars } from '../../common/environmentVars';
import { EventEmitter } from '../../common/events';
import { ILogger, LogTag } from '../../common/logging';
import { once } from '../../common/objUtils';
import { findInPath, forceForwardSlashes, getRandomPipe } from '../../common/pathUtils';
import { delay } from '../../common/promiseUtil';
import { AnyLaunchConfiguration, AnyNodeConfiguration } from '../../configuration';
import { cannotLoadEnvironmentVars } from '../../dap/errors';
import { ProtocolError } from '../../dap/protocolError';
import {
  ILaunchContext,
  ILauncher,
  ILaunchResult,
  IStopMetadata,
  ITarget,
} from '../../targets/targets';
import { ITelemetryReporter } from '../../telemetry/telemetryReporter';
import { ISourcePathResolverFactory } from '../sourcePathResolverFactory';
import {
  IBootloaderEnvironment,
  IBootloaderInfo,
  variableDelimiter,
} from './bootloader/environment';
import { bootloaderDefaultPath } from './bundlePaths';
import { Capability, INodeBinaryProvider, NodeBinary } from './nodeBinaryProvider';
import { NodeSourcePathResolver } from './nodeSourcePathResolver';
import { INodeTargetLifecycleHooks, NodeTarget } from './nodeTarget';
import { NodeWorkerTarget } from './nodeWorkerTarget';
import { IProgram } from './program';
import { WatchdogTarget } from './watchdogSpawn';

/**
 * Telemetry received from the nested process.
 */
export interface IProcessTelemetry {
  /**
   * Process working directory.
   */
  cwd: string;

  /**
   * Target process ID.
   */
  processId: number;

  /**
   * Process node version.
   */
  nodeVersion: string;

  /**
   * CPU architecture.
   */
  architecture: string;
}

/**
 * Data stored for a currently running debug session within the Node launcher.
 */
export interface IRunData<T> {
  server: net.Server;
  serverAddress: string;
  pathResolver: NodeSourcePathResolver;
  context: ILaunchContext;
  logger: ILogger;
  params: T;
}

@injectable()
export abstract class NodeLauncherBase<T extends AnyNodeConfiguration> implements ILauncher {
  /**
   * Data set while a debug session is running.
   */
  protected run?: IRunData<T>;

  /**
   * Attached server connections. Tracked so they can be torn down readily.
   */
  private serverConnections = new Set<Connection>();

  /**
   * Target list.
   */
  private readonly targets = new ObservableMap<string, ITarget>();

  /**
   * Underlying emitter fired when sessions terminate. Listened to by the
   * binder and used to trigger a `terminate` message on the DAP.
   */
  private onTerminatedEmitter = new EventEmitter<IStopMetadata>();

  /**
   * @inheritdoc
   */
  public readonly onTerminated = this.onTerminatedEmitter.event;

  /**
   * @inheritdoc
   */
  public readonly onTargetListChanged = this.targets.onChanged;

  /**
   * The currently running program. Set to undefined if there's no process
   * running.
   */
  protected program?: IProgram;

  /**
   * Bootloader file, if created.
   */
  private bootloaderFile = once(this.getBootloaderFile.bind(this));

  /**
   * Map of all cached openers we've seen. It's possible for a command to run
   * and spawn another command and then exit. We want to make that command
   * debuggable so long as there is anyone in the tree to parent to, so we
   * can use this tree to look that up (where targets are deleted once exited).
   */
  private seenOpeners = new Map</* opener ID */ string, { openedBy: string | undefined }>();

  constructor(
    @inject(INodeBinaryProvider) private readonly pathProvider: INodeBinaryProvider,
    @inject(ILogger) protected readonly logger: ILogger,
    @inject(IPortLeaseTracker) protected readonly portLeaseTracker: IPortLeaseTracker,
    @inject(ISourcePathResolverFactory) protected readonly pathResolverFactory:
      ISourcePathResolverFactory,
  ) {}

  /**
   * @inheritdoc
   */
  public async launch(
    params: AnyLaunchConfiguration,
    context: ILaunchContext,
  ): Promise<ILaunchResult> {
    const resolved = this.resolveParams(params);
    if (!resolved) {
      return { blockSessionTermination: false };
    }

    this._stopServer(); // clear any ongoing run

    const { server, pipe } = await this._startServer(context.telemetryReporter);
    const logger = this.logger.forTarget();
    const run = (this.run = {
      server,
      serverAddress: pipe,
      params: resolved,
      context,
      logger,
      pathResolver: this.pathResolverFactory.create(
        resolved,
        this.logger,
      ) as NodeSourcePathResolver,
    });

    await this.launchProgram(run);
    return { blockSessionTermination: true };
  }

  /**
   * @inheritdoc
   */
  public async terminate(): Promise<void> {
    if (this.program) {
      await this.program.stop();
    } else {
      this.onProgramTerminated({ code: 0, killed: true });
    }
  }

  /**
   * Restarts the ongoing program.
   */
  public async restart(newParams: AnyLaunchConfiguration): Promise<void> {
    if (!this.run) {
      return;
    }

    // Clear the program so that termination logic doesn't run.
    const program = this.program;
    if (program) {
      this.program = undefined;
      await program.stop();

      const closeOk = await Promise.race([
        delay(2000).then(() => false),
        Promise.all([...this.serverConnections].map(c => new Promise(r => c.onDisconnected(r)))),
      ]);

      if (!closeOk) {
        this.logger.warn(LogTag.RuntimeLaunch, 'Timeout waiting for server connections to close');
        this.closeAllConnections();
      }
    }

    // relaunch the program, releasing the initial cancellation token:
    await this.launchProgram({
      ...this.run,
      params: newParams ? this.resolveParams(newParams) ?? this.run.params : this.run.params,
      context: {
        ...this.run.context,
        cancellationToken: this.run.params.timeout > 0
          ? CancellationTokenSource.withTimeout(this.run.params.timeout).token
          : NeverCancelled,
      },
    });
  }

  public targetList(): ITarget[] {
    return [...this.targets.value()];
  }

  /**
   * @inheritdoc
   */
  public dispose() {
    this._stopServer();
  }

  /**
   * Returns the params type if they can be launched by this launcher,
   * or undefined if they cannot.
   */
  protected abstract resolveParams(params: AnyLaunchConfiguration): T | undefined;

  /**
   * Launches the program. Called after the server is running and upon restart.
   */
  protected abstract launchProgram(runData: IRunData<T>): Promise<void>;

  /**
   * Method that should be called when the program from launchProgram() exits.
   * Emits a stop to the client and tears down the server.
   */
  protected onProgramTerminated(result: IStopMetadata) {
    this.onTerminatedEmitter.fire(result);
    this._stopServer();
    this.program = undefined;
  }

  /**
   * Resolves and validates the path to the Node binary as specified in
   * the params.
   */
  protected resolveNodePath(params: T, executable = 'node') {
    return this.pathProvider.resolveAndValidate(
      EnvironmentVars.merge(EnvironmentVars.processEnv(), this.getConfiguredEnvironment(params)),
      executable,
      params.nodeVersionHint,
      params.cwd,
    );
  }

  /**
   * Returns the user-configured portion of the environment variables.
   */
  protected getConfiguredEnvironment(params: T) {
    let baseEnv = EnvironmentVars.empty;

    // read environment variables from any specified file
    if (params.envFile) {
      try {
        baseEnv = baseEnv.merge(readEnvFile(params.envFile));
      } catch (e) {
        throw new ProtocolError(cannotLoadEnvironmentVars(e.message));
      }
    }

    return baseEnv.merge(params.env);
  }

  /**
   * Gets the environment variables for the session.
   */
  protected async resolveEnvironment(
    { params, serverAddress }: IRunData<T>,
    binary: NodeBinary,
    additionalOptions?: Partial<IBootloaderInfo>,
  ) {
    const baseEnv = this.getConfiguredEnvironment(params);
    const bootloader = await this.bootloaderFile(params.cwd, binary);

    const bootloaderInfo: IBootloaderInfo = {
      inspectorIpc: serverAddress,
      deferredMode: false,
      // todo: look at reimplementing the filter
      // NODE_INSPECTOR_WAIT_FOR_DEBUGGER: this._launchParams!.nodeFilter || '',
      waitForDebugger: '',
      // Supply some node executable for running top-level watchdog in Electron
      // environments. Bootloader will replace this with actual node executable used if any.
      execPath: await findInPath(fs.promises, 'node', process.env),
      onlyEntrypoint: !params.autoAttachChildProcesses,
      verbose: params.trace === true || (typeof params.trace === 'object' && params.trace.stdio)
        ? true
        : undefined,
      autoAttachMode: AutoAttachMode.Always,
      mandatePortTracking: this.portLeaseTracker.isMandated ? true : undefined,
      ...additionalOptions,
    };

    const env = {
      // Require our bootloader first, to run it before any other bootloader
      // we could have injected in the parent process.
      NODE_OPTIONS: ` --require ${bootloader.interpolatedPath} `,
      VSCODE_INSPECTOR_OPTIONS: variableDelimiter + JSON.stringify(bootloaderInfo),
      ELECTRON_RUN_AS_NODE: null,
    } as IBootloaderEnvironment;

    const baseEnvOpts = baseEnv.lookup('NODE_OPTIONS');
    if (baseEnvOpts) {
      env.NODE_OPTIONS += ` ${baseEnvOpts} `;
    }

    const globalOpts = EnvironmentVars.processEnv().lookup('NODE_OPTIONS');
    if (globalOpts) {
      env.NODE_OPTIONS += ` ${globalOpts}`;
    }

    return baseEnv.merge({ ...env });
  }

  /**
   * Logic run when a thread is created.
   */
  protected createLifecycle(
    // eslint-disable-next-line
    _cdp: Cdp.Api,
    // eslint-disable-next-line
    _run: IRunData<T>,
    // eslint-disable-next-line
    _target: Cdp.Target.TargetInfo,
  ): INodeTargetLifecycleHooks {
    return {};
  }

  protected async _startServer(telemetryReporter: ITelemetryReporter) {
    const pipe = getRandomPipe();
    const server = await new Promise<net.Server>((resolve, reject) => {
      const s = net
        .createServer(socket => this._startSession(socket, telemetryReporter))
        .on('error', reject)
        .listen(pipe, () => resolve(s));
    });

    return { pipe, server };
  }

  protected _stopServer() {
    this.run?.server.close();
    this.run = undefined;
    this.bootloaderFile.value?.then(f => f.dispose());
    this.bootloaderFile.forget();
    this.closeAllConnections();
  }

  protected closeAllConnections() {
    this.serverConnections.forEach(c => c.close());
    this.serverConnections.clear();
  }

  protected async _startSession(socket: net.Socket, telemetryReporter: ITelemetryReporter) {
    if (!this.run) {
      return;
    }

    const { connection, cdp, targetInfo } = await this.acquireTarget(
      socket,
      telemetryReporter,
      this.run.logger,
    );
    if (!this.run) {
      // if we aren't running a session, discard the socket.
      socket.destroy();
      return;
    }

    if (targetInfo.processId === undefined) {
      targetInfo.processId = Number(targetInfo.targetId); // old bootloaders
    }

    let livingOpenerId = targetInfo.openerId;
    while (
      livingOpenerId && !this.targets.get(livingOpenerId) && this.seenOpeners.has(livingOpenerId)
    ) {
      livingOpenerId = this.seenOpeners.get(livingOpenerId)?.openedBy;
    }

    const target = new NodeTarget(
      this.run.params,
      this.run.context.targetOrigin,
      connection,
      cdp,
      targetInfo,
      this.run.logger,
      this.createLifecycle(cdp, this.run, targetInfo),
      livingOpenerId ? this.targets.get(livingOpenerId) : undefined,
    );

    this.seenOpeners.set(targetInfo.targetId, { openedBy: targetInfo.openerId });
    this.listenToWorkerDomain(cdp, telemetryReporter, target);
    this.targets.add(targetInfo.targetId, target);
    target.onDisconnect(() => this.targets.remove(targetInfo.targetId));
  }

  private async listenToWorkerDomain(
    cdp: Cdp.Api,
    telemetryReporter: ITelemetryReporter,
    parent: NodeTarget,
  ) {
    cdp.NodeWorker.on('attachedToWorker', evt => {
      const transport = new WorkerTransport(evt.sessionId, cdp);
      const target = new NodeWorkerTarget(
        parent.launchConfig,
        {
          attached: true,
          canAccessOpener: false,
          type: 'node-worker',
          targetId: `${parent.id()}-${evt.sessionId}`,
          title: evt.workerInfo.title,
          url: evt.workerInfo.url,
          openerId: parent.id(),
        },
        parent,
        parent.targetOrigin(),
        new Connection(transport, parent.logger, telemetryReporter).rootSession(),
        parent.logger,
      );

      const disposables = new DisposableList();
      disposables.push(transport);
      disposables.push(parent.onDisconnect(() => disposables.dispose()));
      disposables.push(transport.onEnd(() => disposables.dispose()));
      disposables.callback(() => this.targets.remove(target.id()));
      this.targets.add(target.id(), target);
    });
  }

  /**
   * Acquires the CDP session and target info from the connecting socket.
   */
  protected async acquireTarget(
    socket: net.Socket,
    rawTelemetryReporter: ITelemetryReporter,
    logger: ILogger,
  ) {
    const connection = new Connection(
      new RawPipeTransport(logger, socket),
      logger,
      rawTelemetryReporter,
    );

    this.serverConnections.add(connection);
    connection.onDisconnected(() => this.serverConnections.delete(connection));

    const cdp = connection.rootSession();
    const { targetInfo } = await new Promise<Cdp.Target.TargetCreatedEvent>(f =>
      cdp.Target.on('targetCreated', f)
    );

    const cast = targetInfo as WatchdogTarget;
    const portLease = this.portLeaseTracker.register(cast.processInspectorPort);
    connection.onDisconnected(() => portLease.dispose());

    return {
      targetInfo: cast,
      cdp,
      connection,
      logger,
    };
  }

  /**
   * Returns the file from which to load our bootloader. We need to do this in
   * since Node does not support paths with spaces in them < 13 (nodejs/node#12971),
   * so if our installation path has spaces, we need to fall back somewhere.
   */
  protected async getBootloaderFile(cwd: string | undefined, binary: NodeBinary) {
    const targetPath = forceForwardSlashes(bootloaderDefaultPath);

    // 1. If the path doesn't have a space, we're OK to use it.
    if (!targetPath.includes(' ')) {
      return { interpolatedPath: targetPath, dispose: () => undefined };
    }

    // 1.5. If we can otherwise use spaces in the path, quote and return it.
    if (binary.has(Capability.UseSpacesInRequirePath)) {
      return { interpolatedPath: `"${targetPath}"`, dispose: () => undefined };
    }

    // 2. Try the tmpdir, if it's space-free.
    const contents = `require(${JSON.stringify(targetPath)})`;
    if (!os.tmpdir().includes(' ') || !cwd) {
      const tmpPath = path.join(os.tmpdir(), 'vscode-js-debug-bootloader.js');
      await fs.promises.writeFile(tmpPath, contents);
      return { interpolatedPath: tmpPath, dispose: () => undefined };
    }

    // 3. Worst case, write into the cwd. This is messy, but we have few options.
    const nearFilename = '.vscode-js-debug-bootloader.js';
    const nearPath = path.join(cwd, nearFilename);
    await fs.promises.writeFile(nearPath, contents);
    return {
      interpolatedPath: `./${nearFilename}`,
      dispose: () => fs.unlinkSync(nearPath),
    };
  }

  /**
   * Reads telemetry from the process.
   */
  protected async gatherTelemetryFromCdp(
    cdp: Cdp.Api,
    run: IRunData<T>,
  ): Promise<IProcessTelemetry | undefined> {
    for (let retries = 0; retries < 8; retries++) {
      const telemetry = await cdp.Runtime.evaluate({
        contextId: 1,
        returnByValue: true,
        // note: for some bizarre reason, if launched with --inspect-brk, the
        // process.pid in extension host debugging is initially undefined.
        expression:
          `typeof process === 'undefined' || process.pid === undefined ? 'process not defined' : ({ processId: process.pid, nodeVersion: process.version, architecture: process.arch })`
          + getSourceSuffix(),
      });

      if (!this.program) {
        return; // shut down
      }

      if (!telemetry || !telemetry.result.value) {
        this.logger.error(LogTag.RuntimeTarget, 'Undefined result getting telemetry');
        return;
      }

      if (typeof telemetry.result.value !== 'object') {
        this.logger.info(LogTag.RuntimeTarget, 'Process not yet defined, will retry');
        await delay(50 * 2 ** retries);
        continue;
      }

      const result = telemetry.result.value as IProcessTelemetry;
      run.context.telemetryReporter.report('nodeRuntime', {
        version: result.nodeVersion,
        arch: result.architecture,
      });
      this.program.gotTelemetery(result);

      return result;
    }

    return undefined;
  }
}

function readEnvFile(file: string): { [key: string]: string } {
  if (!fs.existsSync(file)) {
    return {};
  }

  const buffer = stripBOM(fs.readFileSync(file, 'utf8'));
  const env = dotenv.parse(Buffer.from(buffer));

  return env;
}

function stripBOM(s: string): string {
  if (s && s[0] === '\uFEFF') {
    s = s.substr(1);
  }
  return s;
}
