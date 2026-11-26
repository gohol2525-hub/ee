export interface QpdfModule {
  FS: {
    mkdir(path: string): void;
    writeFile(path: string, data: Uint8Array): void;
    readFile(path: string): Uint8Array;
    chdir(path: string): void;
  };
  callMain(args: string[]): number;
}

export type QpdfInit = (options: Record<string, unknown>) => Promise<QpdfModule>;

export interface QpdfResult {
  code: number;
  files: Record<string, Uint8Array>;
  messages: string[];
}

let sink: string[] | null = null;
let jobs = 0;
const capture = (...parts: unknown[]) => { sink?.push(parts.map(String).join(' ')); };

/** qpdf binds console.log/error while initializing; route its output to the per-run sink instead of the console. */
export function createQpdfModule(init: QpdfInit, options: Record<string, unknown>) {
  const { log, error } = console;
  console.log = capture;
  console.error = capture;
  try {
    return init({ ...options, noInitialRun: true });
  } finally {
    console.log = log;
    console.error = error;
  }
}

export function runQpdf(module: QpdfModule, args: string[], inputs: Record<string, Uint8Array>, outputs: string[]): QpdfResult {
  const dir = `/job-${++jobs}`;
  module.FS.mkdir(dir);
  for (const [name, bytes] of Object.entries(inputs)) module.FS.writeFile(`${dir}/${name}`, bytes);
  const messages: string[] = [];
  sink = messages;
  let code: number;
  try {
    module.FS.chdir(dir);
    try {
      code = module.callMain(args);
    } catch (error) {
      const status = (error as { status?: unknown } | null)?.status;
      if (typeof status !== 'number') throw new Error('qpdf stopped unexpectedly');
      code = status;
    }
  } finally {
    sink = null;
    module.FS.chdir('/');
  }
  const files: Record<string, Uint8Array> = {};
  for (const name of outputs) {
    try { files[name] = module.FS.readFile(`${dir}/${name}`); } catch { /* not produced */ }
  }
  for (const name of [...Object.keys(inputs), ...outputs]) {
    try { module.FS.writeFile(`${dir}/${name}`, new Uint8Array()); } catch { /* best-effort release */ }
  }
  return { code, files, messages };
}
