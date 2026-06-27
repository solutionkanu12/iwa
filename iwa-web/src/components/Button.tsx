import type { ButtonHTMLAttributes } from "react";
import styles from "./Button.module.css";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "solid" | "ghost" | "dark";
}

/**
 * Primary action button. Iris fill with Cloud text by default. On hover it
 * shrinks to ~0.95 and deepens to near-black ink. It never scales up. The
 * ghost variant is transparent with a hairline border and the same hover.
 */
export function Button({
  variant = "solid",
  className,
  children,
  type = "button",
  ...rest
}: ButtonProps) {
  const cls = [styles.button, styles[variant], className]
    .filter(Boolean)
    .join(" ");
  return (
    <button type={type} className={cls} {...rest}>
      {children}
    </button>
  );
}
