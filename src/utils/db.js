import axios from 'axios';
import Dexie from 'dexie';
import store from '@/store';
// import pkg from "../../package.json";

const db = new Dexie('SPlayMusic');
const electron =
  process.env.IS_ELECTRON === true ? window.require('electron') : null;
const ipcRenderer =
  process.env.IS_ELECTRON === true ? electron.ipcRenderer : null;

db.version(4).stores({
  trackDetail: '&id, updateTime',
  lyric: '&id, updateTime',
  album: '&id, updateTime',
});

db.version(3)
  .stores({
    trackSources: '&id, createTime',
  })
  .upgrade(tx =>
    tx
      .table('trackSources')
      .toCollection()
      .modify(
        track => !track.createTime && (track.createTime = new Date().getTime())
      )
  );

db.version(1).stores({
  trackSources: '&id',
});

let tracksCacheBytes = 0;

async function deleteExcessCache() {
  if (
    store.state.settings.cacheLimit === false ||
    tracksCacheBytes < store.state.settings.cacheLimit * Math.pow(1024, 2)
  ) {
    return;
  }
  try {
    const delCache = await db.trackSources.orderBy('createTime').first();
    await db.trackSources.delete(delCache.id);
    tracksCacheBytes -= delCache.source.byteLength;
    console.debug(
      `[debug][db.js] deleteExcessCacheSucces, track: ${delCache.name}, size: ${delCache.source.byteLength}, cacheSize:${tracksCacheBytes}`
    );
    deleteExcessCache();
  } catch (error) {
    console.debug('[debug][db.js] deleteExcessCacheFailed', error);
  }
}

export function cacheTrackSource(trackInfo, url, bitRate, from = 'netease') {
  if (!process.env.IS_ELECTRON) return;
  const name = trackInfo.name;
  const artist =
    (trackInfo.ar && trackInfo.ar[0]?.name) ||
    (trackInfo.artists && trackInfo.artists[0]?.name) ||
    'Unknown';
  let cover = trackInfo.al.picUrl;
  if (cover.slice(0, 5) !== 'https') {
    cover = 'https' + cover.slice(4);
  }
  axios.get(`${cover}?param=512y512`);
  axios.get(`${cover}?param=224y224`);
  axios.get(`${cover}?param=1024y1024`);
  return axios
    .get(url, {
      responseType: 'arraybuffer',
    })
    .then(response => {
      const trackSource = {
        id: trackInfo.id,
        source: response.data,
        bitRate,
        from,
        name,
        artist,
        createTime: new Date().getTime(),
      };

      if (ipcRenderer) {
        return ipcRenderer
          .invoke('cache:saveTrackSource', trackSource)
          .then(() => {
            console.debug(
              `[debug][db.js] cached track 👉 ${name} by ${artist}`
            );
            return { trackID: trackInfo.id, source: response.data, bitRate };
          })
          .catch(error => {
            console.debug('[debug][db.js] file cache failed', error);
            return db.trackSources.put(trackSource).then(() => {
              tracksCacheBytes += response.data.byteLength;
              deleteExcessCache();
              return { trackID: trackInfo.id, source: response.data, bitRate };
            });
          });
      }

      return db.trackSources.put(trackSource).then(() => {
        console.debug(`[debug][db.js] cached track 👉 ${name} by ${artist}`);
        tracksCacheBytes += response.data.byteLength;
        deleteExcessCache();
        return { trackID: trackInfo.id, source: response.data, bitRate };
      });
    });
}

export function getTrackSource(id) {
  if (ipcRenderer) {
    return ipcRenderer
      .invoke('cache:getTrackSource', id)
      .then(track => {
        if (track) return track;
        return getTrackSourceFromIndexedDB(id);
      })
      .catch(error => {
        console.debug('[debug][db.js] read file cache failed', error);
        return getTrackSourceFromIndexedDB(id);
      });
  }

  return getTrackSourceFromIndexedDB(id);
}

function getTrackSourceFromIndexedDB(id) {
  return db.trackSources.get(Number(id)).then(track => {
    if (!track) return null;
    console.debug(
      `[debug][db.js] get track from cache 👉 ${track.name} by ${track.artist}`
    );
    return track;
  });
}

export function cacheTrackDetail(track, privileges) {
  db.trackDetail.put({
    id: track.id,
    detail: track,
    privileges: privileges,
    updateTime: new Date().getTime(),
  });
}

export function getTrackDetailFromCache(ids) {
  return db.trackDetail
    .filter(track => {
      return ids.includes(String(track.id));
    })
    .toArray()
    .then(tracks => {
      const result = { songs: [], privileges: [] };
      ids.map(id => {
        const one = tracks.find(t => String(t.id) === id);
        result.songs.push(one?.detail);
        result.privileges.push(one?.privileges);
      });
      if (result.songs.includes(undefined)) {
        return undefined;
      }
      return result;
    });
}

export function cacheLyric(id, lyrics) {
  db.lyric.put({
    id,
    lyrics,
    updateTime: new Date().getTime(),
  });
}

export function getLyricFromCache(id) {
  return db.lyric.get(Number(id)).then(result => {
    if (!result) return undefined;
    return result.lyrics;
  });
}

export function cacheAlbum(id, album) {
  db.album.put({
    id: Number(id),
    album,
    updateTime: new Date().getTime(),
  });
}

export function getAlbumFromCache(id) {
  return db.album.get(Number(id)).then(result => {
    if (!result) return undefined;
    return result.album;
  });
}

export function countDBSize() {
  if (ipcRenderer) {
    return ipcRenderer.invoke('cache:getInfo').then(data => ({
      bytes: data.bytes,
      length: data.length,
      path: data.path,
      defaultPath: data.defaultPath,
      isDefault: data.isDefault,
    }));
  }

  const trackSizes = [];
  return db.trackSources
    .each(track => {
      trackSizes.push(track.source.byteLength);
    })
    .then(() => {
      const res = {
        bytes: trackSizes.reduce((s1, s2) => s1 + s2, 0),
        length: trackSizes.length,
      };
      tracksCacheBytes = res.bytes;
      console.debug(
        `[debug][db.js] load tracksCacheBytes: ${tracksCacheBytes}`
      );
      return res;
    });
}

export function clearDB() {
  const clearIndexedDB = () =>
    new Promise(resolve => {
      db.tables.forEach(function (table) {
        table.clear();
      });
      resolve();
    });

  if (ipcRenderer) {
    return ipcRenderer.invoke('cache:clear').then(() => clearIndexedDB());
  }

  return clearIndexedDB();
}

export function getCacheInfo() {
  if (!ipcRenderer) return countDBSize();
  return ipcRenderer.invoke('cache:getInfo');
}

export function selectCacheDirectory() {
  if (!ipcRenderer) return Promise.resolve(null);
  return ipcRenderer.invoke('cache:selectDirectory');
}

export function resetCacheDirectory() {
  if (!ipcRenderer) return Promise.resolve(null);
  return ipcRenderer.invoke('cache:resetDirectory');
}

export function openCacheDirectory() {
  if (!ipcRenderer) return Promise.resolve(null);
  return ipcRenderer.invoke('cache:openDirectory');
}

export function migrateIndexedDBCacheToFile() {
  if (!ipcRenderer) return Promise.resolve({ migrated: 0 });
  return db.trackSources.toArray().then(async tracks => {
    let migrated = 0;
    for (const track of tracks) {
      await ipcRenderer.invoke('cache:saveTrackSource', track);
      migrated += 1;
    }
    return { migrated };
  });
}
