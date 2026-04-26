import { useState, useMemo } from 'react';
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  flexRender,
  type ColumnDef,
  type SortingState,
  type RowSelectionState,
} from '@tanstack/react-table';
import {
  ChevronUp,
  ChevronDown,
  ChevronsLeft,
  ChevronsRight,
  ChevronLeft,
  ChevronRight,
  Search,
  Inbox,
} from 'lucide-react';
import clsx from 'clsx';

interface DataTableProps<T> {
  data: T[];
  columns: ColumnDef<T, unknown>[];
  loading?: boolean;
  searchable?: boolean;
  searchPlaceholder?: string;
  paginated?: boolean;
  pageSize?: number;
  selectable?: boolean;
  onRowSelection?: (selectedRows: T[]) => void;
  emptyMessage?: string;
  emptyDescription?: string;
}

function SkeletonRow({ columns }: { columns: number }) {
  return (
    <tr className="border-b border-line/60">
      {Array.from({ length: columns }).map((_, i) => (
        <td key={i} className="px-3 py-2.5">
          <div className="skeleton h-3.5 w-full max-w-[180px]" />
        </td>
      ))}
    </tr>
  );
}

export default function DataTable<T>({
  data,
  columns,
  loading = false,
  searchable = false,
  searchPlaceholder = 'Search...',
  paginated = true,
  pageSize = 10,
  selectable = false,
  onRowSelection,
  emptyMessage = 'No data found',
  emptyDescription = 'There are no records to display.',
}: DataTableProps<T>) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [globalFilter, setGlobalFilter] = useState('');
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});

  const allColumns = useMemo(() => {
    if (!selectable) return columns;

    const selectColumn: ColumnDef<T, unknown> = {
      id: 'select',
      header: ({ table }) => (
        <input
          type="checkbox"
          className="h-3.5 w-3.5 rounded border-line-strong bg-surface-1 accent-accent focus:ring-accent/30"
          checked={table.getIsAllPageRowsSelected()}
          onChange={table.getToggleAllPageRowsSelectedHandler()}
        />
      ),
      cell: ({ row }) => (
        <input
          type="checkbox"
          className="h-3.5 w-3.5 rounded border-line-strong bg-surface-1 accent-accent focus:ring-accent/30"
          checked={row.getIsSelected()}
          onChange={row.getToggleSelectedHandler()}
        />
      ),
      size: 36,
      enableSorting: false,
    };

    return [selectColumn, ...columns];
  }, [columns, selectable]);

  const table = useReactTable({
    data,
    columns: allColumns,
    state: { sorting, globalFilter, rowSelection },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    onRowSelectionChange: (updater) => {
      const newSelection =
        typeof updater === 'function' ? updater(rowSelection) : updater;
      setRowSelection(newSelection);

      if (onRowSelection) {
        const selectedIndices = Object.keys(newSelection)
          .filter((key) => newSelection[key])
          .map(Number);
        onRowSelection(selectedIndices.map((i) => data[i]));
      }
    },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: paginated ? getPaginationRowModel() : undefined,
    enableRowSelection: selectable,
    initialState: { pagination: { pageSize } },
  });

  const pageSizeOptions = [10, 20, 50, 100];

  return (
    <div className="w-full">
      {searchable && (
        <div className="mb-3 flex items-center gap-3">
          <div className="relative flex-1">
            <Search
              size={14}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-faint"
            />
            <input
              type="text"
              value={globalFilter}
              onChange={(e) => setGlobalFilter(e.target.value)}
              placeholder={searchPlaceholder}
              className="input pl-8 text-[12px]"
            />
          </div>
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-line bg-surface-2">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              {table.getHeaderGroups().map((headerGroup) => (
                <tr
                  key={headerGroup.id}
                  className="border-b border-line"
                >
                  {headerGroup.headers.map((header) => (
                    <th
                      key={header.id}
                      className={clsx(
                        'px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-fg-muted',
                        header.column.getCanSort() &&
                          'cursor-pointer select-none hover:text-fg-secondary',
                      )}
                      style={{
                        width:
                          header.getSize() !== 150
                            ? header.getSize()
                            : undefined,
                      }}
                      onClick={header.column.getToggleSortingHandler()}
                    >
                      <div className="flex items-center gap-1">
                        {header.isPlaceholder
                          ? null
                          : flexRender(
                              header.column.columnDef.header,
                              header.getContext(),
                            )}
                        {header.column.getIsSorted() === 'asc' && (
                          <ChevronUp size={12} className="text-accent" />
                        )}
                        {header.column.getIsSorted() === 'desc' && (
                          <ChevronDown size={12} className="text-accent" />
                        )}
                      </div>
                    </th>
                  ))}
                </tr>
              ))}
            </thead>
            <tbody>
              {loading ? (
                Array.from({ length: pageSize }).map((_, i) => (
                  <SkeletonRow key={i} columns={allColumns.length} />
                ))
              ) : table.getRowModel().rows.length === 0 ? (
                <tr>
                  <td
                    colSpan={allColumns.length}
                    className="px-3 py-12 text-center"
                  >
                    <div className="flex flex-col items-center gap-2">
                      <Inbox size={20} className="text-fg-faint" />
                      <p className="text-[12px] font-medium text-fg-muted">
                        {emptyMessage}
                      </p>
                      <p className="text-[11px] text-fg-faint">
                        {emptyDescription}
                      </p>
                    </div>
                  </td>
                </tr>
              ) : (
                table.getRowModel().rows.map((row) => (
                  <tr
                    key={row.id}
                    className={clsx(
                      'border-b border-line/40 transition-colors last:border-0',
                      row.getIsSelected()
                        ? 'bg-accent/5'
                        : 'hover:bg-tint/30',
                    )}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <td
                        key={cell.id}
                        className="px-3 py-2.5 text-[12px] text-fg-secondary"
                      >
                        {flexRender(
                          cell.column.columnDef.cell,
                          cell.getContext(),
                        )}
                      </td>
                    ))}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {paginated && !loading && data.length > 0 && (
          <div className="flex items-center justify-between border-t border-line px-3 py-2.5">
            <div className="flex items-center gap-2 text-[11px] text-fg-muted">
              <span>
                <span className="font-medium text-fg-secondary">
                  {table.getState().pagination.pageIndex *
                    table.getState().pagination.pageSize +
                    1}
                </span>
                {' - '}
                <span className="font-medium text-fg-secondary">
                  {Math.min(
                    (table.getState().pagination.pageIndex + 1) *
                      table.getState().pagination.pageSize,
                    table.getFilteredRowModel().rows.length,
                  )}
                </span>
                {' of '}
                <span className="font-medium text-fg-secondary">
                  {table.getFilteredRowModel().rows.length}
                </span>
              </span>

              <select
                value={table.getState().pagination.pageSize}
                onChange={(e) => table.setPageSize(Number(e.target.value))}
                className="ml-1 rounded border border-line-strong bg-surface-1 px-1.5 py-0.5 text-[10px] text-fg-muted outline-none focus:border-line-strong"
              >
                {pageSizeOptions.map((size) => (
                  <option key={size} value={size}>
                    {size} / page
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-center gap-0.5">
              <button
                onClick={() => table.setPageIndex(0)}
                disabled={!table.getCanPreviousPage()}
                className="rounded p-1 text-fg-muted transition-colors hover:bg-tint hover:text-fg-secondary disabled:opacity-30"
              >
                <ChevronsLeft size={14} />
              </button>
              <button
                onClick={() => table.previousPage()}
                disabled={!table.getCanPreviousPage()}
                className="rounded p-1 text-fg-muted transition-colors hover:bg-tint hover:text-fg-secondary disabled:opacity-30"
              >
                <ChevronLeft size={14} />
              </button>
              <span className="px-2 text-[11px] text-fg-muted">
                <span className="font-medium text-fg-secondary">
                  {table.getState().pagination.pageIndex + 1}
                </span>
                {' / '}
                {table.getPageCount()}
              </span>
              <button
                onClick={() => table.nextPage()}
                disabled={!table.getCanNextPage()}
                className="rounded p-1 text-fg-muted transition-colors hover:bg-tint hover:text-fg-secondary disabled:opacity-30"
              >
                <ChevronRight size={14} />
              </button>
              <button
                onClick={() => table.setPageIndex(table.getPageCount() - 1)}
                disabled={!table.getCanNextPage()}
                className="rounded p-1 text-fg-muted transition-colors hover:bg-tint hover:text-fg-secondary disabled:opacity-30"
              >
                <ChevronsRight size={14} />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
