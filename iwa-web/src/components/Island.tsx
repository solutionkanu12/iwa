import type { HTMLAttributes } from "react";
import styles from "./Island.module.css";

type IslandProps = HTMLAttributes<HTMLDivElement>;

/**
 * Island container: a floating, edge-detached surface with a soft
 * lavender-tinted shadow. The structural primitive for the app column and
 * sections.
 */
export function Island({ className, children, ...rest }: IslandProps) {
  const cls = className ? `${styles.island} ${className}` : styles.island;
  return (
    <div className={cls} {...rest}>
      {children}
    </div>
  );
}
