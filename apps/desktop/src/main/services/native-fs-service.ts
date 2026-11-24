import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import {
  classifyFileByName,
  err,
  MAX_UPLOAD_BYTES,
  ok,
  PickLocalFilesInputSchema,
  PickLocalFilesOutputSchema,
  SafeFileNameSchema,
  SaveLocalFileInputSchema,
  SaveLocalFileOutputSchema,
  type PickedLocalFile,
  type PickLocalFilesInput,
  type PickLocalFilesOutput,
  type Result,
  type SaveLocalFileInput,
  type SaveLocalFileOutput,
} from '@sunrise/shared';

export interface NativeFsRuntimeDeps {
  readonly showOpenDialog: (options: {
    readonly multiple: boolean;
    readonly allowedExtensions?: readonly string[];
  }) => Promise<{ readonly canceled: boolean; readonly filePaths: readonly string[] }>;
  readonly showSaveDialog: (suggestedName: string) => Promise<{
    readonly canceled: boolean;
    readonly filePath?: string;
  }>;
  readonly statFileSize: (filePath: string) => Promise<number>;
  readonly writeFileBytes: (filePath: string, data: Buffer) => Promise<void>;
}

export interface NativeFsService {
  readonly pickFiles: (input: PickLocalFilesInput) => Promise<Result<PickLocalFilesOutput>>;
  readonly saveFile: (input: SaveLocalFileInput) => Promise<Result<SaveLocalFileOutput>>;
  readonly resolveFileToken: (token: string) => string | null;
}

async function inspectPickedFiles(
  filePaths: readonly string[],
  statFileSize: (filePath: string) => Promise<number>,
  tokenToPath: Map<string, string>,
): Promise<Result<PickedLocalFile[]>> {
  const files: PickedLocalFile[] = [];
  for (const filePath of filePaths) {
    const fileName = basename(filePath);
    if (!SafeFileNameSchema.safeParse(fileName).success) {
      return err({
        code: 'VALIDATION_ERROR',
        message: 'Selected file name violates safety policy',
      });
    }
    let sizeBytes: number;
    try {
      sizeBytes = await statFileSize(filePath);
    } catch {
      return err({
        code: 'INTERNAL_ERROR',
        message: 'Unable to read metadata for selected local file',
      });
    }
    if (sizeBytes < 0 || sizeBytes > MAX_UPLOAD_BYTES) {
      return err({
        code: 'VALIDATION_ERROR',
        message: 'Selected file exceeds maximum allowed upload size',
      });
    }
    const token = randomUUID();
    tokenToPath.set(token, filePath);
    files.push({
      fileToken: token,
      fileName,
      sizeBytes,
      mimeType: classifyFileByName(fileName).mimeType,
    });
  }
  return ok(files);
}

export function createNativeFsService(deps: NativeFsRuntimeDeps): NativeFsService {
  const tokenToPath = new Map<string, string>();

  return {
    pickFiles: async (input): Promise<Result<PickLocalFilesOutput>> => {
      const parsed = PickLocalFilesInputSchema.safeParse(input);
      if (!parsed.success) {
        return err({
          code: 'VALIDATION_ERROR',
          message: parsed.error.issues[0]?.message ?? 'Invalid file picker options',
        });
      }
      let dialogResult: { readonly canceled: boolean; readonly filePaths: readonly string[] };
      try {
        dialogResult = await deps.showOpenDialog({
          multiple: parsed.data.multiple,
          ...(parsed.data.allowedExtensions !== undefined
            ? { allowedExtensions: parsed.data.allowedExtensions }
            : {}),
        });
      } catch {
        return err({ code: 'INTERNAL_ERROR', message: 'Failed to open local file picker' });
      }
      if (dialogResult.canceled) {
        return ok(PickLocalFilesOutputSchema.parse({ canceled: true, files: [] }));
      }
      const inspected = await inspectPickedFiles(
        dialogResult.filePaths,
        deps.statFileSize,
        tokenToPath,
      );
      if (!inspected.ok) {
        return inspected;
      }
      return ok(PickLocalFilesOutputSchema.parse({ canceled: false, files: inspected.value }));
    },

    saveFile: async (input): Promise<Result<SaveLocalFileOutput>> => {
      const parsed = SaveLocalFileInputSchema.safeParse(input);
      if (!parsed.success) {
        return err({
          code: 'VALIDATION_ERROR',
          message: parsed.error.issues[0]?.message ?? 'Invalid save file payload',
        });
      }
      const bytes = Buffer.from(parsed.data.contentBase64, 'base64');
      if (bytes.length > MAX_UPLOAD_BYTES) {
        return err({
          code: 'VALIDATION_ERROR',
          message: 'File content exceeds maximum allowed size',
        });
      }
      let dialogResult: { readonly canceled: boolean; readonly filePath?: string };
      try {
        dialogResult = await deps.showSaveDialog(parsed.data.suggestedName);
      } catch {
        return err({ code: 'INTERNAL_ERROR', message: 'Failed to open local save dialog' });
      }
      if (dialogResult.canceled || !dialogResult.filePath) {
        return ok(SaveLocalFileOutputSchema.parse({ saved: false, canceled: true }));
      }
      try {
        await deps.writeFileBytes(dialogResult.filePath, bytes);
      } catch {
        return err({ code: 'INTERNAL_ERROR', message: 'Failed to write local file' });
      }
      const savedFileName = basename(dialogResult.filePath);
      const safeName = SafeFileNameSchema.safeParse(savedFileName);
      return ok(
        SaveLocalFileOutputSchema.parse({
          saved: true,
          canceled: false,
          ...(safeName.success ? { savedFileName: safeName.data } : {}),
        }),
      );
    },

    resolveFileToken: (token): string | null => tokenToPath.get(token) ?? null,
  };
}
