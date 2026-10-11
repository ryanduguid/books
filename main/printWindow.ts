import { App, BrowserWindow } from 'electron';
import { Stats } from 'fs';
import fs from 'fs/promises';
import path from 'path';

function sameIdentity(left: Stats, right: Stats) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.birthtimeMs === right.birthtimeMs
  );
}

export async function withPrintWindow<T>(
  html: string,
  app: App,
  width: number,
  height: number,
  render: (window: BrowserWindow) => Promise<T>
): Promise<T> {
  if (
    typeof html !== 'string' ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new TypeError('Invalid print document or page dimensions.');
  }
  const directory = await fs.mkdtemp(
    path.join(app.getPath('temp'), 'books-print-')
  );
  const htmlPath = path.join(directory, 'document.html');
  let directoryIdentity: Stats | undefined;
  let htmlIdentity: Stats | undefined;
  let window: BrowserWindow | undefined;
  let primaryError: unknown;
  let result: T | undefined;
  try {
    directoryIdentity = await fs.lstat(directory);
    const file = await fs.open(htmlPath, 'wx', 0o600);
    try {
      htmlIdentity = await file.stat();
      await file.writeFile(html, 'utf8');
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      try {
        await file.close();
      } catch (error) {
        if (primaryError instanceof Error) {
          const primary = primaryError as Error & { cleanupErrors?: string[] };
          primary.cleanupErrors = [
            ...(primary.cleanupErrors ?? []),
            String(error),
          ];
        } else throw error;
      }
    }
    window = new BrowserWindow({
      width: Math.floor(width * 28.333333),
      height: Math.floor(height * 28.333333),
      show: false,
    });
    await window.loadFile(htmlPath);
    result = await render(window);
  } catch (error) {
    primaryError = error;
  }
  const cleanupErrors: string[] = [];
  try {
    if (window && !window.isDestroyed()) window.destroy();
  } catch (error) {
    cleanupErrors.push(String(error));
  }
  try {
    if (!directoryIdentity)
      throw new Error(
        `Print cleanup retained unverified directory: ${directory}`
      );
    const currentDirectory = await fs.lstat(directory);
    if (
      !currentDirectory.isDirectory() ||
      currentDirectory.isSymbolicLink() ||
      !sameIdentity(currentDirectory, directoryIdentity)
    ) {
      throw new Error(`Print cleanup retained changed directory: ${directory}`);
    }
    if (htmlIdentity) {
      const currentFile = await fs.lstat(htmlPath);
      if (
        !currentFile.isFile() ||
        currentFile.isSymbolicLink() ||
        currentFile.nlink !== 1 ||
        !sameIdentity(currentFile, htmlIdentity)
      ) {
        throw new Error(`Print cleanup retained changed file: ${htmlPath}`);
      }
      await fs.unlink(htmlPath);
    }
    await fs.rmdir(directory);
  } catch (error) {
    cleanupErrors.push(String(error));
  }
  if (cleanupErrors.length) {
    if (!primaryError)
      primaryError = new Error('Print resource cleanup failed.');
    if (primaryError instanceof Error) {
      const error = primaryError as Error & { cleanupErrors?: string[] };
      error.cleanupErrors = [...(error.cleanupErrors ?? []), ...cleanupErrors];
    }
  }
  if (primaryError) throw primaryError;
  return result as T;
}
