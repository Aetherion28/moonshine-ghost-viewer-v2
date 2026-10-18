// Stub: noclip's settings store isn't part of this viewer; every setting keeps its default.
export const GlobalSaveManager = {
  loadSetting<T>(_k: string, def: T): T { return def; },
  saveSetting(_k: string, _v: any) { },
  addSettingListener(_k: string, _f: any) { },
};
