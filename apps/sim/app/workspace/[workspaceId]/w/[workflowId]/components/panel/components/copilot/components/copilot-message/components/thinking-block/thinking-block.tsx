'use client'

import { memo, useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { Brain, ChevronDown } from 'lucide-react'
import { formatDuration } from '@/lib/core/utils/formatting'
import { CopilotMarkdownRenderer } from '../markdown-renderer'

/** Removes thinking tags (raw or escaped) and special tags from streamed content */
function stripThinkingTags(text: string): string {
  return text
    .replace(/<\/?thinking[^>]*>/gi, '')
    .replace(/&lt;\/?thinking[^&]*&gt;/gi, '')
    .replace(/<options>[\s\S]*?<\/options>/gi, '')
    .replace(/<options>[\s\S]*$/gi, '')
    .replace(/<plan>[\s\S]*?<\/plan>/gi, '')
    .replace(/<plan>[\s\S]*$/gi, '')
    .trim()
}

/** Interval for auto-scroll during streaming (ms) */
const SCROLL_INTERVAL = 50

/** Timer update interval in milliseconds */
const TIMER_UPDATE_INTERVAL = 100

/** Thinking text streaming delay - faster than main text */
const THINKING_DELAY = 0.5
const THINKING_CHARS_PER_FRAME = 3

/** Props for the SmoothThinkingText component */
interface SmoothThinkingTextProps {
  content: string
  isStreaming: boolean
}

/**
 * Renders thinking content with fast streaming animation.
 */
const SmoothThinkingText = memo(
  ({ content, isStreaming }: SmoothThinkingTextProps) => {
    const [displayedContent, setDisplayedContent] = useState(() => (isStreaming ? '' : content))
    const contentRef = useRef(content)
    const textRef = useRef<HTMLDivElement>(null)
    const rafRef = useRef<number | null>(null)
    const indexRef = useRef(isStreaming ? 0 : content.length)
    const lastFrameTimeRef = useRef<number>(0)
    const isAnimatingRef = useRef(false)

    useEffect(() => {
      contentRef.current = content

      if (content.length === 0) {
        setDisplayedContent('')
        indexRef.current = 0
        return
      }

      if (isStreaming) {
        if (indexRef.current < content.length && !isAnimatingRef.current) {
          isAnimatingRef.current = true
          lastFrameTimeRef.current = performance.now()

          const animateText = (timestamp: number) => {
            const currentContent = contentRef.current
            const currentIndex = indexRef.current
            const elapsed = timestamp - lastFrameTimeRef.current

            if (elapsed >= THINKING_DELAY) {
              if (currentIndex < currentContent.length) {
                const newIndex = Math.min(
                  currentIndex + THINKING_CHARS_PER_FRAME,
                  currentContent.length
                )
                const newDisplayed = currentContent.slice(0, newIndex)
                setDisplayedContent(newDisplayed)
                indexRef.current = newIndex
                lastFrameTimeRef.current = timestamp
              }
            }

            if (indexRef.current < currentContent.length) {
              rafRef.current = requestAnimationFrame(animateText)
            } else {
              isAnimatingRef.current = false
            }
          }

          rafRef.current = requestAnimationFrame(animateText)
        }
      } else {
        if (rafRef.current) {
          cancelAnimationFrame(rafRef.current)
        }
        setDisplayedContent(content)
        indexRef.current = content.length
        isAnimatingRef.current = false
      }

      return () => {
        if (rafRef.current) {
          cancelAnimationFrame(rafRef.current)
        }
        isAnimatingRef.current = false
      }
    }, [content, isStreaming])

    return (
      <div
        ref={textRef}
        className='[&_*]:!text-[var(--text-secondary)] [&_*]:!text-[13px] [&_*]:!leading-[1.6] [&_p]:!m-0 [&_p]:!mb-1.5 [&_h1]:!text-[13px] [&_h1]:!font-semibold [&_h1]:!m-0 [&_h1]:!mb-1 [&_h2]:!text-[13px] [&_h2]:!font-semibold [&_h2]:!m-0 [&_h2]:!mb-1 [&_h3]:!text-[13px] [&_h3]:!font-semibold [&_h3]:!m-0 [&_h3]:!mb-1 [&_code]:!text-[12px] [&_code]:!font-mono [&_ul]:!pl-4 [&_ul]:!my-1 [&_ol]:!pl-5 [&_ol]:!my-1 [&_li]:!my-0.5 [&_li]:!py-0 font-season text-[13px] text-[var(--text-secondary)]'
      >
        <CopilotMarkdownRenderer content={displayedContent} />
      </div>
    )
  },
  (prevProps, nextProps) => {
    return (
      prevProps.content === nextProps.content && prevProps.isStreaming === nextProps.isStreaming
    )
  }
)

SmoothThinkingText.displayName = 'SmoothThinkingText'

/** Props for the ThinkingBlock component */
interface ThinkingBlockProps {
  /** Content of the thinking block */
  content: string
  /** Whether the block is currently streaming */
  isStreaming?: boolean
  /** Whether there are more content blocks after this one (e.g., tool calls) */
  hasFollowingContent?: boolean
  /** Custom label for the thinking block (e.g., "Thinking", "Exploring"). Defaults to "Thought" */
  label?: string
  /** Whether special tags (plan, options) are present */
  hasSpecialTags?: boolean
}

/**
 * Displays AI reasoning/thinking process with collapsible content and duration timer.
 * Cursor IDE style: left border accent, brain icon, always expanded by default.
 */
export function ThinkingBlock({
  content,
  isStreaming = false,
  hasFollowingContent = false,
  label = 'Thought',
  hasSpecialTags = false,
}: ThinkingBlockProps) {
  const cleanContent = useMemo(() => stripThinkingTags(content || ''), [content])

  const [isExpanded, setIsExpanded] = useState(true)
  const [duration, setDuration] = useState(0)
  const [userHasScrolledAway, setUserHasScrolledAway] = useState(false)
  const userCollapsedRef = useRef<boolean>(false)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const startTimeRef = useRef<number>(Date.now())
  const lastScrollTopRef = useRef(0)
  const programmaticScrollRef = useRef(false)

  /** Auto-expands when content arrives during streaming */
  useEffect(() => {
    if (isStreaming && !userCollapsedRef.current && cleanContent.length > 0) {
      setIsExpanded(true)
    }
  }, [isStreaming, cleanContent])

  useEffect(() => {
    if (isStreaming && !hasFollowingContent) {
      startTimeRef.current = Date.now()
      setDuration(0)
      setUserHasScrolledAway(false)
    }
  }, [isStreaming, hasFollowingContent])

  useEffect(() => {
    if (!isStreaming || hasFollowingContent) return

    const interval = setInterval(() => {
      setDuration(Date.now() - startTimeRef.current)
    }, TIMER_UPDATE_INTERVAL)

    return () => clearInterval(interval)
  }, [isStreaming, hasFollowingContent])

  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container || !isExpanded) return

    const handleScroll = () => {
      if (programmaticScrollRef.current) return

      const { scrollTop, scrollHeight, clientHeight } = container
      const distanceFromBottom = scrollHeight - scrollTop - clientHeight
      const isNearBottom = distanceFromBottom <= 20

      const delta = scrollTop - lastScrollTopRef.current
      const movedUp = delta < -1

      if (movedUp && !isNearBottom) {
        setUserHasScrolledAway(true)
      }

      if (userHasScrolledAway && isNearBottom && delta > 10) {
        setUserHasScrolledAway(false)
      }

      lastScrollTopRef.current = scrollTop
    }

    container.addEventListener('scroll', handleScroll, { passive: true })
    lastScrollTopRef.current = container.scrollTop

    return () => container.removeEventListener('scroll', handleScroll)
  }, [isExpanded, userHasScrolledAway])

  useEffect(() => {
    if (!isStreaming || !isExpanded || userHasScrolledAway) return

    const intervalId = window.setInterval(() => {
      const container = scrollContainerRef.current
      if (!container) return

      programmaticScrollRef.current = true
      container.scrollTo({
        top: container.scrollHeight,
        behavior: 'auto',
      })
      window.setTimeout(() => {
        programmaticScrollRef.current = false
      }, 16)
    }, SCROLL_INTERVAL)

    return () => window.clearInterval(intervalId)
  }, [isStreaming, isExpanded, userHasScrolledAway])

  const hasContent = cleanContent.length > 0
  const isThinkingDone = !isStreaming || hasFollowingContent || hasSpecialTags
  const roundedMs = Math.max(1000, Math.round(duration / 1000) * 1000)
  const durationText = `${label} for ${formatDuration(roundedMs)}`

  const getStreamingLabel = (lbl: string) => {
    if (lbl === 'Thought') return 'Thinking'
    if (lbl.endsWith('ed')) return `${lbl.slice(0, -2)}ing`
    return lbl
  }
  const streamingLabel = getStreamingLabel(label)

  if (!isThinkingDone) {
    return (
      <div className='my-1'>
        <style>{`
          @keyframes thinking-shimmer {
            0% { background-position: 150% 0; }
            50% { background-position: 0% 0; }
            100% { background-position: -150% 0; }
          }
          @keyframes thinking-pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.4; }
          }
        `}</style>
        <button
          onClick={() => {
            setIsExpanded((v) => {
              const next = !v
              if (!next) userCollapsedRef.current = true
              return next
            })
          }}
          className='group flex w-full items-center gap-1.5 text-left'
          type='button'
        >
          <Brain
            className='h-3.5 w-3.5 flex-shrink-0 text-[var(--text-muted)]'
            style={{ animation: 'thinking-pulse 2s ease-in-out infinite' }}
            aria-hidden='true'
          />
          <span className='relative inline-block flex-1'>
            <span className='font-[450] text-[13px] text-[var(--text-tertiary)]'>
              {streamingLabel}
            </span>
            <span
              aria-hidden='true'
              className='pointer-events-none absolute inset-0 select-none overflow-hidden'
            >
              <span
                className='block text-[13px] text-transparent'
                style={{
                  backgroundImage:
                    'linear-gradient(90deg, rgba(255,255,255,0) 0%, rgba(255,255,255,0.85) 50%, rgba(255,255,255,0) 100%)',
                  backgroundSize: '200% 100%',
                  backgroundRepeat: 'no-repeat',
                  WebkitBackgroundClip: 'text',
                  backgroundClip: 'text',
                  animation: 'thinking-shimmer 1.4s ease-in-out infinite',
                  mixBlendMode: 'screen',
                }}
              >
                {streamingLabel}
              </span>
            </span>
          </span>
          {hasContent && (
            <ChevronDown
              className={clsx(
                'h-3.5 w-3.5 flex-shrink-0 text-[var(--text-muted)] transition-transform duration-200 group-hover:text-[var(--text-secondary)]',
                isExpanded ? 'rotate-180' : 'rotate-0'
              )}
              aria-hidden='true'
            />
          )}
        </button>

        {hasContent && (
          <div
            className={clsx(
              'overflow-hidden transition-all duration-200 ease-out',
              isExpanded ? 'mt-2 max-h-[260px] opacity-100' : 'max-h-0 opacity-0'
            )}
          >
            <div
              ref={scrollContainerRef}
              className='max-h-[260px] overflow-y-auto border-[var(--border-subtle)] border-l-2 pl-3'
            >
              <SmoothThinkingText
                content={cleanContent}
                isStreaming={isStreaming && !hasFollowingContent}
              />
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className='my-1'>
      <button
        onClick={() => {
          setIsExpanded((v) => !v)
        }}
        className='group flex w-full items-center gap-1.5 text-left'
        type='button'
        disabled={!hasContent}
      >
        <Brain className='h-3.5 w-3.5 flex-shrink-0 text-[var(--text-muted)]' aria-hidden='true' />
        <span className='flex-1 text-[13px] text-[var(--text-muted)] transition-colors duration-150 group-hover:text-[var(--text-secondary)]'>
          {durationText}
        </span>
        {hasContent && (
          <ChevronDown
            className={clsx(
              'h-3.5 w-3.5 flex-shrink-0 text-[var(--text-muted)] transition-transform duration-200 group-hover:text-[var(--text-secondary)]',
              isExpanded ? 'rotate-180' : 'rotate-0'
            )}
            aria-hidden='true'
          />
        )}
      </button>

      {hasContent && (
        <div
          className={clsx(
            'overflow-hidden transition-all duration-200 ease-out',
            isExpanded ? 'mt-2 max-h-[260px] opacity-100' : 'max-h-0 opacity-0'
          )}
        >
          <div
            ref={scrollContainerRef}
            className='max-h-[260px] overflow-y-auto border-[var(--border-subtle)] border-l-2 pl-3'
          >
            <div className='[&_*]:!text-[var(--text-secondary)] [&_*]:!text-[13px] [&_*]:!leading-[1.6] [&_p]:!m-0 [&_p]:!mb-1.5 [&_h1]:!text-[13px] [&_h1]:!font-semibold [&_h1]:!m-0 [&_h1]:!mb-1 [&_h2]:!text-[13px] [&_h2]:!font-semibold [&_h2]:!m-0 [&_h2]:!mb-1 [&_h3]:!text-[13px] [&_h3]:!font-semibold [&_h3]:!m-0 [&_h3]:!mb-1 [&_code]:!text-[12px] [&_code]:!font-mono [&_ul]:!pl-4 [&_ul]:!my-1 [&_ol]:!pl-5 [&_ol]:!my-1 [&_li]:!my-0.5 [&_li]:!py-0 font-season text-[13px] text-[var(--text-secondary)]'>
              <CopilotMarkdownRenderer content={cleanContent} />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
