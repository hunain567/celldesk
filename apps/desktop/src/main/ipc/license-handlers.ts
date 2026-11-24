import { LICENSE_EXTENSION, REQUEST_EXTENSION } from '@nexodesk/licensing';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { AppError } from '../errors';
import type { LicenseService } from '../licensing/service';
import type { IpcRouter } from './router';

const MAX_LICENSE_FILE_BYTES = 64 * 1024;

export interface LicenseHandlerDependencies {
  license: LicenseService;
  /** Native save dialog; returns the chosen path or null. */
  chooseRequestSavePath: (suggestedName: string) => Promise<string | null>;
  /** Native open dialog for .ndlic files; returns the chosen path or null. */
  chooseLicenseFile: () => Promise<string | null>;
  onLicenseChanged: () => void;
}

export function registerLicenseHandlers(router: IpcRouter, deps: LicenseHandlerDependencies): void {
  router.register('license:status', () => deps.license.status());

  router.register('license:requestCode', () => ({ code: deps.license.createRequestCode() }));

  router.register('license:saveRequestFile', async () => {
    const date = new Date().toISOString().slice(0, 10);
    const path = await deps.chooseRequestSavePath(`NexoDesk-activation-request-${date}${REQUEST_EXTENSION}`);
    if (!path) return { path: null };
    await writeFile(path, deps.license.createRequestCode(), 'utf8');
    return { path };
  });

  router.register('license:importFile', async () => {
    const path = await deps.chooseLicenseFile();
    if (!path) return null;
    if (!path.toLowerCase().endsWith(LICENSE_EXTENSION)) {
      throw new AppError('VALIDATION_FAILED', `Choose a NexoDesk licence file (${LICENSE_EXTENSION}).`);
    }
    if ((await stat(path)).size > MAX_LICENSE_FILE_BYTES) {
      throw new AppError('VALIDATION_FAILED', 'This file is too large to be a NexoDesk licence.');
    }
    const status = deps.license.importLicense(await readFile(path, 'utf8'));
    deps.onLicenseChanged();
    return status;
  });

  router.register('license:importCode', ({ code }) => {
    const status = deps.license.importLicense(code);
    deps.onLicenseChanged();
    return status;
  });
}
