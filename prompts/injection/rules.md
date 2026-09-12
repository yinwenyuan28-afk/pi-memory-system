<!-- 规则注入包裹（分节）。
     loaded-prefix  = context 事件注入规则时的前缀行。
     pi-rules-wrap  = load_memory_rules 对契约正文的 __PI_RULES__ 包裹；
                      {{body}} 与 __PI_RULES_END__ 之间的空行是迁移前既有字节语义，勿删。 -->

## loaded-prefix

[L1 Record Contract Loaded]

## pi-rules-wrap

<!-- vars: body -->
__PI_RULES__
{{body}}

__PI_RULES_END__
