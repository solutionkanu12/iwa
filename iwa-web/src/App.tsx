import { CircleView } from "./screens/CircleView.tsx";
import styles from "./App.module.css";

// App screens sit in a centered mobile column on the Mist ground (PRD section
// 10), with soft lavender orbs drifting behind. `address` is set when the
// visitor already connected a wallet on the landing page, so CircleView can
// skip its own connect prompt.
export interface AppProps {
  address?: string | null;
}

export function App({ address = null }: AppProps = {}) {
  return (
    <main className={styles.appShell}>
      <span className={`${styles.blob} ${styles.blob1}`} aria-hidden="true" />
      <span className={`${styles.blob} ${styles.blob2}`} aria-hidden="true" />
      <div className={styles.appWrap}>
        <CircleView initialAddress={address} />
      </div>
    </main>
  );
}
