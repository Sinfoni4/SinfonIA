import { FORMAT_LABELS, type ExportFormat } from '../api/exports';

/** The choice of the format (CSV, Excel, PDF), next to the button of an export. */
export function FormatSelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: ExportFormat;
  onChange: (format: ExportFormat) => void;
}) {
  return (
    <label htmlFor={id}>
      Formato{' '}
      <select id={id} value={value} onChange={(e) => onChange(e.target.value as ExportFormat)}>
        {(Object.keys(FORMAT_LABELS) as ExportFormat[]).map((f) => (
          <option key={f} value={f}>
            {FORMAT_LABELS[f]}
          </option>
        ))}
      </select>
    </label>
  );
}
