export function Placeholder({ title, phase }: { title: string; phase: string }) {
  return (
    <section className="clay" style={{ padding: 'clamp(1.5rem, 4vw, 2.5rem)' }}>
      <h1 style={{ fontSize: 'clamp(1.5rem, 4vw, 2rem)' }}>{title}</h1>
      <p style={{ color: 'var(--text-muted)' }}>Scheduled for {phase}.</p>
    </section>
  );
}
