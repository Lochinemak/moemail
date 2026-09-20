import { useState, useEffect } from 'react'

interface SendPermissionResponse {
  canSend: boolean
  canViewSent?: boolean
  error?: string
  remainingEmails?: number
  allowedSenderDomain?: string
}

export function useSendPermission() {
  const [canSend, setCanSend] = useState(false)
  const [canViewSent, setCanViewSent] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [remainingEmails, setRemainingEmails] = useState<number | undefined>()
  const [allowedSenderDomain, setAllowedSenderDomain] = useState<string | undefined>()

  const checkPermission = async () => {
    setLoading(true)
    setError(null)
    
    try {
      const response = await fetch('/api/emails/send-permission')
      
      if (!response.ok) {
        throw new Error('权限检查失败')
      }

      const data = await response.json() as SendPermissionResponse
      setCanSend(data.canSend)
      setCanViewSent(data.canViewSent ?? false)
      setRemainingEmails(data.remainingEmails)
      setAllowedSenderDomain(data.allowedSenderDomain)
      
      if (!data.canSend && data.error) {
        setError(data.error)
      }
    } catch (err) {
      setCanSend(false)
      setCanViewSent(false)
      setError(err instanceof Error ? err.message : '权限检查失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    checkPermission()
  }, [])

  return {
    canSend,
    canViewSent,
    loading,
    error,
    remainingEmails,
    allowedSenderDomain,
    canSendFrom: (address: string) => canSend && (
      !allowedSenderDomain || address.toLowerCase().endsWith(`@${allowedSenderDomain}`)
    ),
    checkPermission
  }
}
