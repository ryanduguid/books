import { App } from 'electron';
import { withPrintWindow } from './printWindow';

export async function printHtmlDocument(
  html: string,
  app: App,
  width: number,
  height: number
): Promise<boolean> {
  return withPrintWindow(
    html,
    app,
    width,
    height,
    (window) =>
      new Promise<boolean>((resolve) => {
        window.webContents.print(
          { silent: false, printBackground: true },
          (success) => resolve(success)
        );
      })
  );
}
