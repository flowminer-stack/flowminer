import { useState, useCallback } from 'react';
import { useDropzone, type FileRejection } from 'react-dropzone';
import {
  UploadCloud,
  File as FileIcon,
  X,
  CheckCircle,
  AlertCircle,
} from 'lucide-react';
import clsx from 'clsx';

interface FileUploadProps {
  onFileSelect?: (file: File) => void;
  onUpload?: (file: File) => Promise<void>;
  accept?: Record<string, string[]>;
  maxSize?: number;
  disabled?: boolean;
}

const defaultAccept: Record<string, string[]> = {
  'text/csv': ['.csv'],
  'application/xml': ['.xes'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': [
    '.xlsx',
  ],
  'application/octet-stream': ['.parquet'],
};

function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

export default function FileUpload({
  onFileSelect,
  onUpload,
  accept = defaultAccept,
  maxSize = 500 * 1024 * 1024,
  disabled = false,
}: FileUploadProps) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number>(0);
  const [uploadStatus, setUploadStatus] = useState<
    'idle' | 'uploading' | 'success' | 'error'
  >('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const onDrop = useCallback(
    (acceptedFiles: File[], rejections: FileRejection[]) => {
      if (rejections.length > 0) {
        const rejection = rejections[0];
        const error = rejection.errors[0];
        if (error.code === 'file-too-large') {
          setErrorMessage(
            `File is too large. Maximum size is ${formatFileSize(maxSize)}.`,
          );
        } else if (error.code === 'file-invalid-type') {
          setErrorMessage(
            'Invalid file type. Accepted: .csv, .xes, .xlsx, .parquet',
          );
        } else {
          setErrorMessage(error.message);
        }
        return;
      }

      if (acceptedFiles.length > 0) {
        const file = acceptedFiles[0];
        setSelectedFile(file);
        setErrorMessage(null);
        setUploadStatus('idle');
        setUploadProgress(0);
        onFileSelect?.(file);
      }
    },
    [maxSize, onFileSelect],
  );

  const { getRootProps, getInputProps, isDragActive, isDragReject } =
    useDropzone({
      onDrop,
      accept,
      maxSize,
      multiple: false,
      disabled: disabled || uploadStatus === 'uploading',
    });

  const handleUpload = async () => {
    if (!selectedFile || !onUpload) return;

    setUploadStatus('uploading');
    setUploadProgress(0);
    setErrorMessage(null);

    const progressInterval = setInterval(() => {
      setUploadProgress((prev) => {
        if (prev >= 90) {
          clearInterval(progressInterval);
          return 90;
        }
        return prev + Math.random() * 15;
      });
    }, 300);

    try {
      await onUpload(selectedFile);
      clearInterval(progressInterval);
      setUploadProgress(100);
      setUploadStatus('success');
    } catch (err) {
      clearInterval(progressInterval);
      setUploadStatus('error');
      setErrorMessage(
        err instanceof Error ? err.message : 'Upload failed. Please try again.',
      );
    }
  };

  const handleRemoveFile = () => {
    setSelectedFile(null);
    setUploadStatus('idle');
    setUploadProgress(0);
    setErrorMessage(null);
  };

  const fileExtension = selectedFile?.name.split('.').pop()?.toUpperCase();

  return (
    <div className="w-full">
      {!selectedFile && (
        <div
          {...getRootProps()}
          className={clsx(
            'relative cursor-pointer rounded-lg border border-dashed p-8 text-center transition-all',
            isDragActive && !isDragReject
              ? 'border-accent/50 bg-accent/5'
              : isDragReject
                ? 'border-danger/50 bg-danger/5'
                : 'border-line-strong bg-surface-1 hover:border-line-strong hover:bg-surface-2',
            disabled && 'cursor-not-allowed opacity-50',
          )}
        >
          <input {...getInputProps()} />
          <div className="flex flex-col items-center gap-3">
            <div
              className={clsx(
                'rounded-lg p-2.5',
                isDragActive
                  ? 'bg-accent/10 text-accent'
                  : 'bg-tint text-fg-muted',
              )}
            >
              <UploadCloud size={22} />
            </div>
            <div>
              <p className="text-[13px] font-medium text-fg-secondary">
                {isDragActive
                  ? 'Drop file here...'
                  : 'Drag and drop your event log file'}
              </p>
              <p className="mt-1 text-[11px] text-fg-muted">
                or{' '}
                <span className="font-medium text-accent">browse</span> to
                choose a file
              </p>
            </div>
            <div className="flex flex-wrap justify-center gap-1.5">
              {['.csv', '.xes', '.xlsx', '.parquet'].map((ext) => (
                <span
                  key={ext}
                  className="rounded bg-tint px-1.5 py-0.5 text-[10px] font-medium text-fg-muted"
                >
                  {ext}
                </span>
              ))}
            </div>
            <p className="text-[10px] text-fg-faint">
              Max file size: {formatFileSize(maxSize)}
            </p>
          </div>
        </div>
      )}

      {selectedFile && (
        <div className="rounded-lg border border-line bg-surface-2 p-3.5">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-accent/10">
              <FileIcon size={16} className="text-accent" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-medium text-fg">
                {selectedFile.name}
              </p>
              <div className="flex items-center gap-2 text-[11px] text-fg-muted">
                <span>{formatFileSize(selectedFile.size)}</span>
                {fileExtension && (
                  <>
                    <span className="text-fg-ghost">&middot;</span>
                    <span className="rounded bg-tint px-1 py-px font-medium text-fg-muted">
                      {fileExtension}
                    </span>
                  </>
                )}
              </div>
            </div>
            {uploadStatus === 'success' ? (
              <CheckCircle size={16} className="shrink-0 text-success" />
            ) : uploadStatus === 'error' ? (
              <AlertCircle size={16} className="shrink-0 text-danger" />
            ) : (
              <button
                onClick={handleRemoveFile}
                disabled={uploadStatus === 'uploading'}
                className="shrink-0 rounded p-1 text-fg-muted transition-colors hover:bg-tint hover:text-fg-secondary disabled:opacity-50"
              >
                <X size={14} />
              </button>
            )}
          </div>

          {uploadStatus === 'uploading' && (
            <div className="mt-3">
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-fg-muted">Uploading...</span>
                <span className="font-mono font-medium text-accent">
                  {Math.round(uploadProgress)}%
                </span>
              </div>
              <div className="mt-1 h-1 overflow-hidden rounded-full bg-tint">
                <div
                  className="h-full rounded-full bg-accent transition-all duration-300"
                  style={{ width: `${uploadProgress}%` }}
                />
              </div>
            </div>
          )}

          {uploadStatus === 'idle' && onUpload && (
            <button onClick={handleUpload} className="btn-primary mt-3 w-full text-[12px]">
              Upload File
            </button>
          )}

          {uploadStatus === 'success' && (
            <p className="mt-2.5 text-[12px] font-medium text-success">
              File uploaded successfully
            </p>
          )}
        </div>
      )}

      {errorMessage && (
        <div className="mt-2.5 flex items-center gap-2 rounded-lg border border-danger/20 bg-danger/5 px-3 py-2.5">
          <AlertCircle size={14} className="shrink-0 text-danger" />
          <p className="text-[12px] text-danger">{errorMessage}</p>
        </div>
      )}
    </div>
  );
}
