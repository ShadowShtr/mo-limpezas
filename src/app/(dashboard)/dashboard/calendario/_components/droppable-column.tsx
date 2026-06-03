"use client";

import { useDroppable } from "@dnd-kit/core";

interface DroppableColumnProps {
  id: string;
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  onClick?: (e: React.MouseEvent<HTMLDivElement>) => void;
}

export function DroppableColumn({ id, children, className, style, onClick }: DroppableColumnProps) {
  const { isOver, setNodeRef } = useDroppable({ id });

  return (
    <div
      ref={setNodeRef}
      className={className}
      style={{
        ...style,
        backgroundColor: isOver ? "rgba(22, 163, 74, 0.05)" : undefined,
        transition: "background-color 0.15s ease",
      }}
      onClick={onClick}
    >
      {children}
    </div>
  );
}
