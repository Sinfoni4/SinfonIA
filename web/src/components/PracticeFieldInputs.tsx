import type { CurrentModule } from '../api/modules';

type PracticeType = CurrentModule['practiceTypes'][number];

/**
 * A04: the inputs of the fields a module declares for a kind of practice. Shared by the new
 * practice form and by the creation through a delegation (AGX-04).
 */
export function PracticeFieldInputs({
  type,
  values,
  onChange,
  idPrefix = 'field',
}: {
  type: PracticeType;
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
  idPrefix?: string;
}) {
  return (
    <>
      {type.fields.map((field) => {
        const id = `${idPrefix}-${field.key}`;
        const value = values[field.key] ?? '';
        return (
          <div key={field.key} className="form">
            <label htmlFor={id}>
              {field.label}
              {field.required ? '' : ' (facoltativo)'}
            </label>
            {field.type === 'choice' ? (
              <select id={id} value={value} onChange={(e) => onChange(field.key, e.target.value)}>
                <option value="">—</option>
                {field.options?.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id={id}
                type={field.type === 'text' ? 'text' : field.type}
                maxLength={field.type === 'text' ? (field.maxLength ?? 200) : undefined}
                min={field.min}
                max={field.max}
                value={value}
                onChange={(e) => onChange(field.key, e.target.value)}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

/** Whether a required field of the kind is still empty. */
export function missingRequired(type: PracticeType, values: Record<string, string>): boolean {
  return type.fields.some((f) => f.required && !values[f.key]?.trim());
}
