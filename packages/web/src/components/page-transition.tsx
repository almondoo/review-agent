import { AnimatePresence, animate, type MotionStyle, motion } from 'motion/react';
import type { ReactNode } from 'react';
import { useLocation } from 'react-router-dom';

// Re-export animate for use in other components
export { animate };

type PageTransitionProps = {
  children: ReactNode;
};

export function PageTransition({ children }: PageTransitionProps) {
  const location = useLocation();

  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={location.pathname}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2, ease: 'easeInOut' }}
        style={{ flex: 1, display: 'flex', flexDirection: 'column' }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}

type StaggerContainerProps = {
  children: ReactNode;
  style?: React.CSSProperties;
};

export function StaggerContainer({ children, style }: StaggerContainerProps) {
  return (
    <motion.div
      initial="hidden"
      animate="visible"
      variants={{
        hidden: {},
        visible: {
          transition: { staggerChildren: 0.03 },
        },
      }}
      // exactOptionalPropertyTypes: pass style only when defined to satisfy MotionStyle vs CSSProperties | undefined
      {...(style !== undefined ? { style: style as MotionStyle } : {})}
    >
      {children}
    </motion.div>
  );
}

type StaggerItemProps = {
  children: ReactNode;
  style?: React.CSSProperties;
};

export function StaggerItem({ children, style }: StaggerItemProps) {
  return (
    <motion.div
      variants={{
        hidden: { opacity: 0, y: 12 },
        visible: { opacity: 1, y: 0, transition: { duration: 0.35, ease: 'easeOut' } },
      }}
      // exactOptionalPropertyTypes: pass style only when defined to satisfy MotionStyle vs CSSProperties | undefined
      {...(style !== undefined ? { style: style as MotionStyle } : {})}
    >
      {children}
    </motion.div>
  );
}
