import { useState } from 'react';
import type { ReactNode } from 'react';
import { IconChevronDown } from '@tabler/icons-react';

export function CollapsibleSection({
  title,
  defaultOpen = true,
  headerAccessory,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  // Optional content shown in the header, right-aligned before the chevron.
  // Stays visible while the section is collapsed (e.g. the Signal pills).
  headerAccessory?: ReactNode;
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
        <span className="td-section-title">{title}</span>
        {headerAccessory && <span className="td-section-accessory">{headerAccessory}</span>}
        <IconChevronDown size={16} className={open ? 'td-section-chevron is-open' : 'td-section-chevron'} />
      </button>
      {open && <div className="td-section-body">{children}</div>}
    </section>
  );
}
