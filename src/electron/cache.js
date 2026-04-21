import { app, dialog, shell } from 'electron';

const fs = require('fs').promises;
const path = require('path');

const CACHE_DIR_NAME = 'AudioCache';

function getSettings(store) {
  return store.get('settings') || {};
}

function getDefaultCacheDirectory() {
  return path.join(app.getPath('userData'), CACHE_DIR_NAME);
}

function getCacheDirectory(store) {
  const cacheDirectoryPath = getSettings(store).cacheDirectoryPath;
  return cacheDirectoryPath || getDefaultCacheDirectory();
}

function updateCacheDirectory(store, cacheDirectoryPath) {
  store.set('settings', {
    ...getSettings(store),
    cacheDirectoryPath,
  });
}

function normalizeTrackId(trackId) {
  return String(trackId).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function getTrackFilePath(cacheDirectory, trackId) {
  return path.join(cacheDirectory, `${normalizeTrackId(trackId)}.bin`);
}

function getMetaFilePath(cacheDirectory, trackId) {
  return path.join(cacheDirectory, `${normalizeTrackId(trackId)}.json`);
}

function toBuffer(source) {
  if (Buffer.isBuffer(source)) return source;
  if (source instanceof ArrayBuffer) return Buffer.from(source);
  if (ArrayBuffer.isView(source)) {
    return Buffer.from(source.buffer, source.byteOffset, source.byteLength);
  }
  return Buffer.from(source);
}

function toArrayBuffer(buffer) {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength
  );
}

async function ensureWritableDirectory(cacheDirectory) {
  await fs.mkdir(cacheDirectory, { recursive: true });
  const testFile = path.join(cacheDirectory, '.splaymusic-cache-test');
  await fs.writeFile(testFile, 'ok');
  await removeFile(testFile);
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    return false;
  }
}

async function removeFile(filePath) {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function copyFileIfExists(sourcePath, targetPath) {
  if (!(await pathExists(sourcePath))) return false;
  await fs.copyFile(sourcePath, targetPath);
  return true;
}

async function migrateFileCache(sourceDirectory, targetDirectory) {
  if (sourceDirectory === targetDirectory) {
    return { migrated: 0 };
  }

  await fs.mkdir(sourceDirectory, { recursive: true });
  await ensureWritableDirectory(targetDirectory);
  const metas = await listTrackMetas(sourceDirectory);
  let migrated = 0;

  for (const meta of metas) {
    await Promise.all([
      copyFileIfExists(
        getTrackFilePath(sourceDirectory, meta.id),
        getTrackFilePath(targetDirectory, meta.id)
      ),
      copyFileIfExists(
        getMetaFilePath(sourceDirectory, meta.id),
        getMetaFilePath(targetDirectory, meta.id)
      ),
    ]);
    migrated += 1;
  }

  return { migrated };
}

async function readMeta(metaFilePath) {
  try {
    return JSON.parse(await fs.readFile(metaFilePath, 'utf8'));
  } catch (error) {
    return null;
  }
}

async function listTrackMetas(cacheDirectory) {
  await fs.mkdir(cacheDirectory, { recursive: true });
  const fileNames = await fs.readdir(cacheDirectory);
  const metaFileNames = fileNames.filter(fileName =>
    fileName.endsWith('.json')
  );
  const metas = await Promise.all(
    metaFileNames.map(async fileName =>
      readMeta(path.join(cacheDirectory, fileName))
    )
  );
  return metas.filter(Boolean);
}

export async function getCacheInfo(store) {
  const cacheDirectory = getCacheDirectory(store);
  await fs.mkdir(cacheDirectory, { recursive: true });
  const metas = await listTrackMetas(cacheDirectory);
  const bytes = metas.reduce((total, meta) => total + (meta.size || 0), 0);
  return {
    path: cacheDirectory,
    defaultPath: getDefaultCacheDirectory(),
    isDefault: cacheDirectory === getDefaultCacheDirectory(),
    bytes,
    length: metas.length,
  };
}

export async function selectCacheDirectory(win, store) {
  const previousDirectory = getCacheDirectory(store);
  const result = await dialog.showOpenDialog(win, {
    title: '选择歌曲缓存目录',
    defaultPath: previousDirectory,
    properties: ['openDirectory', 'createDirectory'],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return {
      canceled: true,
      ...(await getCacheInfo(store)),
    };
  }

  const cacheDirectory = result.filePaths[0];
  const migration = await migrateFileCache(previousDirectory, cacheDirectory);
  updateCacheDirectory(store, cacheDirectory);
  return {
    canceled: false,
    fileMigrated: migration.migrated,
    ...(await getCacheInfo(store)),
  };
}

export async function resetCacheDirectory(store) {
  const previousDirectory = getCacheDirectory(store);
  const defaultDirectory = getDefaultCacheDirectory();
  const migration = await migrateFileCache(previousDirectory, defaultDirectory);
  updateCacheDirectory(store, '');
  return {
    fileMigrated: migration.migrated,
    ...(await getCacheInfo(store)),
  };
}

export async function openCacheDirectory(store) {
  const cacheDirectory = getCacheDirectory(store);
  await fs.mkdir(cacheDirectory, { recursive: true });
  const errorMessage = await shell.openPath(cacheDirectory);
  return {
    ok: errorMessage === '',
    errorMessage,
    path: cacheDirectory,
  };
}

export async function saveTrackSource(store, track) {
  const cacheDirectory = getCacheDirectory(store);
  await ensureWritableDirectory(cacheDirectory);
  const trackId = normalizeTrackId(track.id);
  const source = toBuffer(track.source);
  const filePath = getTrackFilePath(cacheDirectory, trackId);
  const metaPath = getMetaFilePath(cacheDirectory, trackId);
  const oldMeta = await readMeta(metaPath);
  const createTime =
    oldMeta && oldMeta.createTime ? oldMeta.createTime : new Date().getTime();

  await fs.writeFile(filePath, source);
  await fs.writeFile(
    metaPath,
    JSON.stringify(
      {
        id: String(track.id),
        bitRate: track.bitRate,
        from: track.from,
        name: track.name,
        artist: track.artist,
        size: source.byteLength,
        createTime,
        updateTime: new Date().getTime(),
      },
      null,
      2
    )
  );

  await deleteExcessCache(store);
  return { ok: true, id: String(track.id), size: source.byteLength };
}

export async function getTrackSource(store, id) {
  const cacheDirectory = getCacheDirectory(store);
  const trackId = normalizeTrackId(id);
  const filePath = getTrackFilePath(cacheDirectory, trackId);
  const metaPath = getMetaFilePath(cacheDirectory, trackId);

  if (!(await pathExists(filePath))) return null;
  const [source, meta] = await Promise.all([
    fs.readFile(filePath),
    readMeta(metaPath),
  ]);

  return {
    ...(meta || { id: String(id) }),
    source: toArrayBuffer(source),
  };
}

export async function clearCache(store) {
  const cacheDirectory = getCacheDirectory(store);
  await fs.mkdir(cacheDirectory, { recursive: true });
  const fileNames = await fs.readdir(cacheDirectory);
  await Promise.all(
    fileNames
      .filter(
        fileName => fileName.endsWith('.bin') || fileName.endsWith('.json')
      )
      .map(fileName => removeFile(path.join(cacheDirectory, fileName)))
  );
  return getCacheInfo(store);
}

export async function deleteExcessCache(store) {
  const cacheLimit = getSettings(store).cacheLimit;
  if (cacheLimit === false) return;

  const cacheDirectory = getCacheDirectory(store);
  const maxBytes = cacheLimit * Math.pow(1024, 2);
  let metas = await listTrackMetas(cacheDirectory);
  let totalBytes = metas.reduce((total, meta) => total + (meta.size || 0), 0);

  if (totalBytes <= maxBytes) return;

  metas = metas.sort((a, b) => (a.createTime || 0) - (b.createTime || 0));
  for (const meta of metas) {
    if (totalBytes <= maxBytes) break;
    await Promise.all([
      removeFile(getTrackFilePath(cacheDirectory, meta.id)),
      removeFile(getMetaFilePath(cacheDirectory, meta.id)),
    ]);
    totalBytes -= meta.size || 0;
  }
}
