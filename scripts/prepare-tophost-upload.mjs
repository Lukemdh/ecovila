import { cp, chmod, mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE_MODE = 0o644;
const DIRECTORY_MODE = 0o755;
const IGNORED_NAMES = new Set(['.DS_Store', '__MACOSX']);

export const TOPHOST_UPLOAD_ENTRIES = [
  'index.html',
  'site.html',
  'ru',
  'en',
  'rezervari.html',
  'intrebari-frecvente.html',
  'checkout.html',
  'confirmare.html',
  'plata-mia.html',
  'gestionare.html',
  'anulare.html',
  'complaints.html',
  'politica-confidentialitate.html',
  'termeni-conditii.html',
  'robots.txt',
  'sitemap.xml',
  'llms.txt',
  '.htaccess',
  'admin',
  'assets',
  'css',
  'js',
  'favicon.ico',
];

function assertSafeOutput(rootDir, outputDir) {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedOutput = path.resolve(outputDir);

  if (resolvedOutput === resolvedRoot) {
    throw new Error('Output directory cannot be the project root.');
  }

  return { resolvedRoot, resolvedOutput };
}

async function copyDeployPath(sourcePath, targetPath) {
  const sourceStats = await stat(sourcePath);

  if (sourceStats.isDirectory()) {
    await mkdir(targetPath, { recursive: true, mode: DIRECTORY_MODE });
    await chmod(targetPath, DIRECTORY_MODE);

    const directoryEntries = await readdir(sourcePath, { withFileTypes: true });
    for (const entry of directoryEntries) {
      if (IGNORED_NAMES.has(entry.name)) {
        continue;
      }

      await copyDeployPath(
        path.join(sourcePath, entry.name),
        path.join(targetPath, entry.name),
      );
    }

    return;
  }

  if (!sourceStats.isFile()) {
    throw new Error(`Unsupported deploy entry type: ${sourcePath}`);
  }

  await mkdir(path.dirname(targetPath), { recursive: true, mode: DIRECTORY_MODE });
  await cp(sourcePath, targetPath);
  await chmod(targetPath, FILE_MODE);
}

export async function prepareTophostUpload({
  rootDir = process.cwd(),
  outputDir = path.join(rootDir, 'dist', 'tophost'),
  entries = TOPHOST_UPLOAD_ENTRIES,
} = {}) {
  const { resolvedRoot, resolvedOutput } = assertSafeOutput(rootDir, outputDir);

  await rm(resolvedOutput, { recursive: true, force: true });
  await mkdir(resolvedOutput, { recursive: true, mode: DIRECTORY_MODE });
  await chmod(resolvedOutput, DIRECTORY_MODE);

  for (const entry of entries) {
    await copyDeployPath(path.join(resolvedRoot, entry), path.join(resolvedOutput, entry));
  }

  return {
    outputDir: resolvedOutput,
    copiedEntries: [...entries],
    fileMode: FILE_MODE,
    directoryMode: DIRECTORY_MODE,
  };
}

function isCliEntrypoint() {
  if (!process.argv[1]) {
    return false;
  }

  return fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
}

if (isCliEntrypoint()) {
  const result = await prepareTophostUpload();
  console.log(`Prepared Tophost upload folder: ${result.outputDir}`);
  console.log('Permissions normalized: directories 755, files 644');
}
