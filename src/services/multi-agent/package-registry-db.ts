import { getDB } from '@/db';
import type { PackageRegistryRow } from '@/db/types';

export class PackageRegistryDB {
  /**
   * Check if a package has been approved for the given language.
   */
  async isApproved(packageName: string, language: string): Promise<boolean> {
    const db = await getDB();
    const row = await db.get<{ cnt: number }>(
      'SELECT COUNT(*) AS cnt FROM package_registry WHERE package_name = ? AND language = ?',
      [packageName, language],
    );
    return (row?.cnt ?? 0) > 0;
  }

  /**
   * Approve a package for use in the given language (INSERT OR IGNORE).
   */
  async approve(packageName: string, language: string): Promise<void> {
    const db = await getDB();
    await db.execute(
      'INSERT OR IGNORE INTO package_registry (package_name, language) VALUES (?, ?)',
      [packageName, language],
    );
  }

  /**
   * List all approved packages, optionally filtered by language.
   */
  async listApproved(language?: string): Promise<PackageRegistryRow[]> {
    const db = await getDB();
    if (language) {
      return db.query<PackageRegistryRow>(
        'SELECT * FROM package_registry WHERE language = ? ORDER BY package_name ASC',
        [language],
      );
    }
    return db.query<PackageRegistryRow>(
      'SELECT * FROM package_registry ORDER BY language ASC, package_name ASC',
    );
  }

  /**
   * Remove an approved package from the registry.
   */
  async remove(packageName: string, language: string): Promise<void> {
    const db = await getDB();
    await db.execute(
      'DELETE FROM package_registry WHERE package_name = ? AND language = ?',
      [packageName, language],
    );
  }
}
