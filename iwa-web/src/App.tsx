import { CircleView } from "./screens/CircleView.tsx";
import styles from "./App.module.css";

// App screens sit in a centered mobile column on the Mist ground (PRD section
// 10), with soft lavender orbs drifting behind. This step renders only Flow 1,
// the circle view.
export function App() {
  return (
    <main className={styles.appShell}>
      <span className={`${styles.blob} ${styles.blob1}`} aria-hidden="true" />
      <span className={`${styles.blob} ${styles.blob2}`} aria-hidden="true" />
      <div className={styles.appWrap}>
        <CircleView />
      </div>
    </main>
  );
}
