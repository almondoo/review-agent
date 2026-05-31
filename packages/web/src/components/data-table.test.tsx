import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Column } from './data-table.js';
import { DataTable } from './data-table.js';

type Row = { id: string; name: string; value: number };

const columns: Column<Row>[] = [
  { key: 'name', header: 'Name', render: (r) => r.name },
  { key: 'value', header: 'Value', render: (r) => String(r.value), mono: true, align: 'right' },
];

const rows: Row[] = [
  { id: 'a', name: 'Alpha', value: 1 },
  { id: 'b', name: 'Beta', value: 2 },
];

describe('DataTable', () => {
  it('renders column headers', () => {
    render(<DataTable columns={columns} rows={rows} rowKey={(r) => r.id} />);
    expect(screen.getByText('Name')).toBeInTheDocument();
    expect(screen.getByText('Value')).toBeInTheDocument();
  });

  it('renders row data', () => {
    render(<DataTable columns={columns} rows={rows} rowKey={(r) => r.id} />);
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
  });

  it('renders default empty message when rows is empty', () => {
    render(<DataTable columns={columns} rows={[]} rowKey={(r) => r.id} />);
    expect(screen.getByText('No data.')).toBeInTheDocument();
  });

  it('renders custom empty message', () => {
    render(
      <DataTable columns={columns} rows={[]} rowKey={(r) => r.id} emptyMessage="Nothing here." />,
    );
    expect(screen.getByText('Nothing here.')).toBeInTheDocument();
  });

  it('calls onRowClick when a row is clicked', () => {
    const onRowClick = vi.fn();
    render(
      <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} onRowClick={onRowClick} />,
    );
    fireEvent.click(screen.getByText('Alpha'));
    expect(onRowClick).toHaveBeenCalledWith(rows[0]);
  });

  it('does not call onRowClick when handler is absent', () => {
    // Should not throw; no handler wired
    render(<DataTable columns={columns} rows={rows} rowKey={(r) => r.id} />);
    fireEvent.click(screen.getByText('Alpha'));
    // No assertion needed beyond "no error thrown"
  });

  it('applies mono font family to mono columns', () => {
    render(<DataTable columns={columns} rows={rows} rowKey={(r) => r.id} />);
    const cell = screen.getByText('1');
    expect(cell).toHaveStyle({ fontFamily: 'var(--font-mono)' });
  });

  it('applies right text alignment to align=right columns', () => {
    render(<DataTable columns={columns} rows={rows} rowKey={(r) => r.id} />);
    const cell = screen.getByText('1');
    expect(cell).toHaveStyle({ textAlign: 'right' });
  });
});
