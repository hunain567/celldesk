import { settingSchemas, type SettingKey, type SettingValue } from '@nexodesk/shared';
import type { SqliteDatabase } from '../db/connection';

export const settingDefaults: { [K in SettingKey]: SettingValue<K> } = {
  'ui.theme': 'system',
  'ui.sidebarCollapsed': false,
  'security.autoLockMinutes': 15,
};

export class SettingValidationError extends Error {
  constructor(key: string, readonly details: string[]) {
    super(`Invalid value for setting "${key}"`);
    this.name = 'SettingValidationError';
  }
}

/** Typed key/value settings stored as JSON, validated on every write and read. */
export class SettingsStore {
  constructor(private readonly db: SqliteDatabase, private readonly now: () => Date = () => new Date()) {}

  get<K extends SettingKey>(key: K): SettingValue<K> {
    const row = this.db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key) as
      | { value_json: string }
      | undefined;
    if (!row) return settingDefaults[key];
    const parsed = settingSchemas[key].safeParse(JSON.parse(row.value_json));
    // A stored value that no longer matches the schema falls back to the default.
    return parsed.success ? (parsed.data as SettingValue<K>) : settingDefaults[key];
  }

  set<K extends SettingKey>(key: K, value: unknown): SettingValue<K> {
    const parsed = settingSchemas[key].safeParse(value);
    if (!parsed.success) {
      throw new SettingValidationError(
        key,
        parsed.error.issues.map((issue) => issue.message),
      );
    }
    this.db
      .prepare(
        `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(parsed.data), this.now().toISOString());
    return parsed.data as SettingValue<K>;
  }
}
