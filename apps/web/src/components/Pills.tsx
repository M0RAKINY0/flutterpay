export function Pills<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="pills" role="group" aria-label={label}>
      <span className="pills-label">{label}</span>
      {options.map(option => (
        <button
          key={option.value}
          type="button"
          className="pill"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
