import { useState } from 'react';
import type { ReactNode } from 'react';
import { IconChevronDown } from '@tabler/icons-react';

export function CollapsibleSection({
  title,
  defaultOpen = true,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section className="td-section">
      <button
        type="button"
        className="td-section-header"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
      >
        <span>{title}</span>
        <IconChevronDown size={16} className={open ? 'td-section-chevron is-open' : 'td-section-chevron'} />
      </button>
      {open && <div className="td-section-body">{children}</div>}
    </section>
  );
}
