package com.aigateway.app.embedded










object CodeGuard {

    
    enum class Level { LOW, MEDIUM, HIGH }

    
    data class Finding(
        val ruleId: String,
        val level: Level,
        val title: String,      
        val snippet: String     
    )

    
    data class Result(
        val findings: List<Finding>,
        val maxLevel: Level?,
        val scannedChars: Int
    ) {
        val hasRisk: Boolean get() = findings.isNotEmpty()
    }

    private data class Rule(
        val id: String,
        val level: Level,
        val title: String,
        val regex: Regex
    )

    



    private val RULES: List<Rule> = listOf(
        
        Rule("rm_rf_root", Level.HIGH, "Recursive delete of root or home",
            Regex("""\brm\s+(-[a-zA-Z]*\s+)*-?[rRfF]{2,}[a-zA-Z]*\s+(/|~|/\*|\*)(\s|$|;)""")),
        Rule("rm_rf_generic", Level.HIGH, "Forced recursive delete",
            Regex("""\brm\s+-[a-zA-Z]*r[a-zA-Z]*f|rm\s+-[a-zA-Z]*f[a-zA-Z]*r""")),
        Rule("dd_disk", Level.HIGH, "Raw disk write (dd)",
            Regex("""\bdd\s+.*of=\s*/dev/(sd[a-z]|nvme|block|mmcblk|disk)""")),
        Rule("mkfs", Level.HIGH, "Filesystem format",
            Regex("""\bmkfs(\.\w+)?\s+/dev/""")),
        Rule("fork_bomb", Level.HIGH, "Fork bomb",
            Regex(""":\(\)\s*\{\s*:\|:\s*&\s*\}\s*;\s*:|\bwhile\s+true\s*;\s*do\s+.*&\s*done""")),
        Rule("overwrite_dev", Level.HIGH, "Writing to raw device",
            Regex(""">\s*/dev/(sd[a-z]|nvme|block|mmcblk)""")),

        
        Rule("curl_pipe_sh", Level.HIGH, "Download and execute (curl|sh)",
            Regex("""\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|k|da)?sh\b""")),
        Rule("eval_download", Level.HIGH, "Eval of downloaded content",
            Regex("""\beval\s*\(\s*(requests\.get|urllib|fetch|file_get_contents|Invoke-WebRequest)""", RegexOption.IGNORE_CASE)),
        Rule("py_exec_net", Level.HIGH, "Python exec of network content",
            Regex("""\bexec\s*\(\s*(requests\.get|urllib\.request\.urlopen)""")),
        Rule("powershell_iex", Level.HIGH, "PowerShell download-and-run",
            Regex("""\b(iex|Invoke-Expression)\b[^\n]*\b(DownloadString|Invoke-WebRequest|iwr)\b""", RegexOption.IGNORE_CASE)),
        Rule("base64_exec", Level.HIGH, "Base64-decoded execution",
            Regex("""\b(base64\s+-d|b64decode|FromBase64String)[^\n]{0,80}\|\s*(ba)?sh|\b(ba)?sh\s+-c\s+["']?\$\(\s*base64""", RegexOption.IGNORE_CASE)),

        
        Rule("exfil_env", Level.HIGH, "Sending environment variables out",
            Regex("""\b(curl|wget|nc|Invoke-WebRequest)\b[^\n]*(\$\{?ENV|printenv|\benv\b|process\.env|os\.environ)""", RegexOption.IGNORE_CASE)),
        Rule("exfil_ssh_key", Level.HIGH, "Reading private keys / credentials",
            Regex("""(cat|type|Get-Content|open)\s+[^\n]{0,40}(\.ssh/id_[a-z0-9]+|\.aws/credentials|\.env\b|id_rsa|\.pem\b)""", RegexOption.IGNORE_CASE)),
        Rule("reverse_shell", Level.HIGH, "Reverse shell",
            Regex("""\b(nc|ncat|netcat)\b[^\n]*\s-[a-z]*e[a-z]*\s|\bbash\s+-i\s+>&\s*/dev/tcp/|socket\.socket\([^\n]*\)[^\n]*connect\(""", RegexOption.IGNORE_CASE)),

        
        Rule("chmod_777", Level.MEDIUM, "World-writable permissions",
            Regex("""\bchmod\s+(-[a-zA-Z]+\s+)*777\b""")),
        Rule("sudo_nopasswd", Level.MEDIUM, "Passwordless sudo modification",
            Regex("""NOPASSWD\s*:|>>\s*/etc/sudoers""")),
        Rule("disable_firewall", Level.MEDIUM, "Disabling firewall / SELinux",
            Regex("""\b(ufw\s+disable|setenforce\s+0|systemctl\s+(stop|disable)\s+(firewalld|ufw))\b""", RegexOption.IGNORE_CASE)),
        Rule("crontab_inject", Level.MEDIUM, "Cron persistence",
            Regex("""\bcrontab\s+-\s*$|echo\s+[^\n]*\|\s*crontab\b|>>\s*/etc/cron""", RegexOption.MULTILINE)),
        Rule("kill_all", Level.MEDIUM, "Mass process kill",
            Regex("""\bkill(all)?\s+-9\s+(-1|\*)|\bpkill\s+-9\s+-u\b""")),

        
        Rule("js_eval_input", Level.MEDIUM, "eval() of dynamic input",
            Regex("""\beval\s*\(\s*(req\.|request\.|input|argv|params|body)""", RegexOption.IGNORE_CASE)),
        Rule("py_pickle_load", Level.MEDIUM, "Unsafe deserialization (pickle)",
            Regex("""\bpickle\.loads?\s*\(""")),
        Rule("py_os_system_var", Level.MEDIUM, "Shell command from variable",
            Regex("""\b(os\.system|subprocess\.(call|run|Popen))\s*\([^\n]{0,60}(input\(|argv|f["']|\+\s*\w)""")),
        Rule("sql_concat", Level.MEDIUM, "SQL built by string concatenation",
            Regex("""(SELECT|INSERT|UPDATE|DELETE)\b[^\n]{0,80}(\+\s*(input|argv|req|params|user)|%s['"]?\s*%|f["'][^\n]*\{)""", RegexOption.IGNORE_CASE)),

        
        Rule("hardcoded_secret", Level.LOW, "Hardcoded credential-looking string",
            Regex("""\b(api[_-]?key|secret|password|token)\s*[=:]\s*["'][A-Za-z0-9_\-]{16,}["']""", RegexOption.IGNORE_CASE)),
        Rule("http_plain", Level.LOW, "Plain HTTP request to external host",
            Regex("""["']http://(?!(localhost|127\.0\.0\.1|0\.0\.0\.0|192\.168\.|10\.))[a-z0-9.-]+""", RegexOption.IGNORE_CASE)),
        Rule("insecure_tls", Level.LOW, "Certificate verification disabled",
            Regex("""verify\s*=\s*False|rejectUnauthorized\s*:\s*false|InsecureSkipVerify\s*:\s*true|--no-check-certificate""", RegexOption.IGNORE_CASE))
    )

    
    private val FENCE = Regex("```[a-zA-Z0-9_+-]*\\s*\\n?([\\s\\S]*?)```")

    
    private val LOOSE_CMD = Regex("""^\s*[$#>]?\s*(sudo\s+)?(rm|dd|mkfs|chmod|curl|wget|nc|eval|kill|pkill|crontab)\b.*$""", RegexOption.MULTILINE)

    




    fun scan(text: String, minLevel: Level = Level.MEDIUM, maxChars: Int = 200_000): Result {
        if (text.isBlank()) return Result(emptyList(), null, 0)
        val body = if (maxChars > 0 && text.length > maxChars) text.substring(0, maxChars) else text

        
        val segments = ArrayList<String>()
        FENCE.findAll(body).forEach { segments.add(it.groupValues[1]) }
        LOOSE_CMD.findAll(body).forEach { segments.add(it.value) }
        if (segments.isEmpty()) return Result(emptyList(), null, body.length)

        val findings = ArrayList<Finding>()
        val seen = HashSet<String>()
        for (seg in segments) {
            for (rule in RULES) {
                if (rule.level.ordinal < minLevel.ordinal) continue
                val m = rule.regex.find(seg) ?: continue
                if (!seen.add(rule.id)) continue     
                findings.add(Finding(rule.id, rule.level, rule.title, m.value.trim().take(160)))
            }
        }
        val max = findings.maxByOrNull { it.level.ordinal }?.level
        return Result(findings, max, body.length)
    }

    
    fun summarize(r: Result): String {
        if (!r.hasRisk) return "OK"
        return r.findings.joinToString("\n") { "[${it.level}] ${it.title}\n    ${it.snippet}" }
    }

    
    fun ruleCount(): Int = RULES.size
}
