import clsx from "clsx";
import { ReactNode } from "react";
import { FC } from "react";

const DropdownLink: FC<{
  closeOnClick?: boolean;
  active?: boolean;
  disabled?: boolean;
  className?: string;
  onClick: () => void | Promise<void>;
  children: ReactNode;
}> = ({
  active = false,
  disabled = false,
  className = "",
  onClick,
  children,
}) => {
  return (
    <a
      className={clsx("dropdown-item", className, {
        active,
        disabled,
      })}
      href="#"
      onClick={(e) => {
        e.preventDefault();
        onClick();
      }}
    >
      {children}
    </a>
  );
};
export default DropdownLink;
