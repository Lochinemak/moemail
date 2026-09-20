"use client"

import { useState, useRef } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Send } from "lucide-react"
import { useToast } from "@/components/ui/use-toast"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"

interface SendDialogProps {
  emailId: string
  fromAddress: string
  onSendSuccess?: () => void
}

export function SendDialog({ emailId, fromAddress, onSendSuccess }: SendDialogProps) {
  const t = useTranslations("emails.send")
  const tList = useTranslations("emails.list")
  const tCommon = useTranslations("common.actions")
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [to, setTo] = useState("")
  const [subject, setSubject] = useState("")
  const [content, setContent] = useState("")
  const attempt = useRef<{ payload: string; key: string } | null>(null)
  const { toast } = useToast()

  const handleSend = async () => {
    if (!to.trim() || !subject.trim() || !content.trim()) {
      toast({
        title: tList("error"),
        description: t("toPlaceholder") + ", " + t("subjectPlaceholder") + ", " + t("contentPlaceholder"),
        variant: "destructive"
      })
      return
    }

    setLoading(true)
    try {
      const payload = JSON.stringify({ emailId, to, subject, content })
      if (attempt.current?.payload !== payload) attempt.current = { payload, key: crypto.randomUUID() }
      const response = await fetch(`/api/emails/${emailId}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": attempt.current.key },
        body: JSON.stringify({ to, subject, content })
      })

      if (!response.ok) {
        const data = await response.json() as { error: string; retryWithNewKey?: boolean }
        if (data.retryWithNewKey) attempt.current = null
        toast({
          title: tList("error"),
          description: (data as { error: string }).error,
          variant: "destructive"
        })
        return
      }

      toast({
        title: tList("success"),
        description: t("success")
      })
      setOpen(false)
      setTo("")
      setSubject("")
      setContent("")
      attempt.current = null
      
      onSendSuccess?.()
    
    } catch {
      toast({
        title: tList("error"),
        description: t("failed"),
        variant: "destructive"
      })
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <TooltipProvider>
        <Tooltip>
          <DialogTrigger asChild>
            <TooltipTrigger asChild>
              <Button 
                variant="ghost" 
                size="sm"
                className="h-8 gap-2 hover:bg-primary/10 hover:text-primary transition-colors"
              >
                <Send className="h-4 w-4" />
                <span className="hidden sm:inline">{t("title")}</span>
              </Button>
            </TooltipTrigger>
          </DialogTrigger>
          <TooltipContent className="sm:hidden">
            <p>{t("title")}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="text-sm text-muted-foreground">
            {t("from")}: {fromAddress}
          </div>
          <Input
            value={to}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTo(e.target.value)}
            placeholder={t("toPlaceholder")}
          />
          <Input
            value={subject}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSubject(e.target.value)}
            placeholder={t("subjectPlaceholder")}
          />
          <Textarea
            value={content}
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setContent(e.target.value)}
            placeholder={t("contentPlaceholder")}
            rows={6}
          />
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setOpen(false)} disabled={loading}>
            {tCommon("cancel")}
          </Button>
          <Button onClick={handleSend} disabled={loading}>
            {loading ? t("sending") : t("send")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
